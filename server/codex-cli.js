import { spawn } from 'child_process';
import crossSpawn from 'cross-spawn';
import { CodexOutputParser } from './utils/codexOutputParser.js';

// Use cross-spawn on Windows for better command execution
const spawnFunction = process.platform === 'win32' ? crossSpawn : spawn;

let activeCodexProcesses = new Map(); // Track active processes by session ID


async function spawnCodex(command, options = {}, ws) {
  return new Promise(async (resolve, reject) => {
    const { sessionId, projectPath, cwd, resume, toolsSettings, model, images } = options;
    let capturedSessionId = sessionId; // Track session ID throughout the process
    let textBuffer = ''; // Buffer for accumulating text chunks
    let bufferTimer = null; // Timer for flushing buffer

    // Use tools settings passed from frontend, or defaults
    const settings = toolsSettings || {
      allowedTools: [],
      disallowedTools: [],
      skipPermissions: false
    };

    // Use cwd (actual project directory) instead of projectPath
    const workingDir = cwd || projectPath || process.cwd();

    // Generate session ID if not provided
    if (!capturedSessionId) {
      capturedSessionId = 'codex_' + Date.now().toString();
    }

    // Build Codex CLI command
    const args = [];

    // Add model if specified and different from default
    if (model && model !== 'gpt-5') {
      args.push('--model', model);
    }

    // Add working directory
    if (workingDir) {
      args.push('--cd', workingDir);
    }

    // Add dangerous bypass mode if enabled (highest priority)
    if (settings.dangerousBypass) {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    } else if (settings.fullAuto) {
      // Full-auto mode
      args.push('--full-auto');
    } else {
      // Individual sandbox and approval settings
      const sandboxMode = settings.sandboxMode || 'workspace-write';
      args.push('--sandbox', sandboxMode);

      // Use the correct long flag for approval policy
      const approvalPolicy = settings.skipPermissions ? 'never' : 'untrusted';
      args.push('--ask-for-approval', approvalPolicy);
    }

    // Add web search if enabled
    if (settings.enableSearch) {
      args.push('--search');
    }

    // Add exec subcommand before the prompt
    args.push('exec');

    // Add the command/prompt as the last argument
    if (command && command.trim()) {
      args.push(command);
    }

    console.log('Spawning Codex CLI:', 'codex', args.join(' '));
    console.log('Working directory:', workingDir);
    console.log('Session info - Input sessionId:', sessionId, 'Resume:', resume);
    console.log('Model:', model || 'gpt-5');

    const codexProcess = spawnFunction('codex', args, {
      cwd: workingDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env } // Inherit all environment variables
    });

    // Store process reference for potential abort
    const processKey = capturedSessionId || Date.now().toString();
    activeCodexProcesses.set(processKey, codexProcess);

    // Note: Codex exec doesn't create persistent sessions like interactive mode
    // Sessions are only created during interactive Codex usage
    // We don't send session-created events for exec commands

    // Function to flush buffered text to WebSocket
    const flushBuffer = () => {
      if (textBuffer.trim()) {
        console.log('💬 Sending text chunk to UI:', JSON.stringify(textBuffer));
        ws.send(JSON.stringify({
          type: 'codex-response',
          data: {
            type: 'content_block_delta',
            delta: {
              type: 'text_delta',
              text: textBuffer
            }
          }
        }));
        textBuffer = '';
      }
      bufferTimer = null;
    };

    const parser = new CodexOutputParser({
      onText: (textSegment) => {
        if (!textSegment) {
          return;
        }

        console.log('📝 Codex text segment received:', JSON.stringify(textSegment));

        textBuffer += textSegment;

        if (!bufferTimer) {
          bufferTimer = setTimeout(flushBuffer, 300);
        }

        const hasCompleteSentence = /[.!?]\s*$/.test(textBuffer.trim());
        const hasMarkdownBlock = /```[\s\S]*?```$|^#{1,6}\s+.+$|^\s*[-*+]\s+.+$/m.test(textBuffer);

        if (textBuffer.length > 800 || (textBuffer.length > 200 && (hasCompleteSentence || hasMarkdownBlock))) {
          clearTimeout(bufferTimer);
          flushBuffer();
        }
      },
      onReasoning: (reasoning) => {
        if (!reasoning || !reasoning.trim()) {
          return;
        }

        console.log('🧠 Codex reasoning chunk:', reasoning);

        ws.send(JSON.stringify({
          type: 'codex-reasoning',
          data: {
            reasoning
          }
        }));
      }
    });

    // Handle stdout (Codex CLI output)
    codexProcess.stdout.on('data', (data) => {
      const rawOutput = data.toString();
      console.log('📤 Codex CLI stdout:', rawOutput);

      try {
        parser.ingest(rawOutput);
      } catch (error) {
        console.error('Failed to parse Codex output chunk:', error);
      }
    });

    // Handle stderr
    codexProcess.stderr.on('data', (data) => {
      console.error('Codex CLI stderr:', data.toString());
      ws.send(JSON.stringify({
        type: 'codex-error',
        error: data.toString()
      }));
    });

    // Handle process completion
    codexProcess.on('close', async (code) => {
      console.log(`Codex CLI process exited with code ${code}`);

      try {
        parser.finalize();
      } catch (error) {
        console.error('Failed to finalize Codex output parsing:', error);
      }

      // Flush any remaining buffered text
      if (bufferTimer) {
        clearTimeout(bufferTimer);
        bufferTimer = null;
      }
      flushBuffer();

      // Clean up process reference
      activeCodexProcesses.delete(processKey);

      // Send completion signal
      ws.send(JSON.stringify({
        type: 'codex-response',
        data: {
          type: 'content_block_stop'
        }
      }));

      ws.send(JSON.stringify({
        type: 'codex-complete',
        exitCode: code,
        isNewSession: true // Codex exec does create session files
      }));

      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Codex CLI exited with code ${code}`));
      }
    });

    // Handle process errors
    codexProcess.on('error', (error) => {
      console.error('Codex CLI process error:', error);

      // Clean up process reference on error
      activeCodexProcesses.delete(processKey);

      ws.send(JSON.stringify({
        type: 'codex-error',
        error: error.message
      }));

      reject(error);
    });

    // Close stdin since we don't need interactive input
    codexProcess.stdin.end();
  });
}

function abortCodexSession(sessionId) {
  const process = activeCodexProcesses.get(sessionId);
  if (process) {
    console.log(`🛑 Aborting Codex session: ${sessionId}`);
    process.kill('SIGTERM');
    activeCodexProcesses.delete(sessionId);
    return true;
  }
  return false;
}

export {
  spawnCodex,
  abortCodexSession
};

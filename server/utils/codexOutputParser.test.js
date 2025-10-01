import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CodexOutputParser } from './codexOutputParser.js';

const collectOutputs = () => {
  const textChunks = [];
  const reasoningMessages = [];

  return {
    parser: new CodexOutputParser({
      onText: (chunk) => {
        textChunks.push(chunk);
      },
      onReasoning: (message) => {
        reasoningMessages.push(message);
      }
    }),
    textChunks,
    reasoningMessages
  };
};

test('CodexOutputParser separates reasoning from final response', () => {
  const { parser, textChunks, reasoningMessages } = collectOutputs();

  parser.ingest('[2024-05-01T12:00:00] thinking\nI should enumerate options.\n');
  parser.ingest('[2024-05-01T12:00:01] codex\nSure, here is the plan.\n');
  parser.finalize();

  assert.deepEqual(reasoningMessages, ['I should enumerate options.']);
  assert.strictEqual(textChunks.join(''), 'Sure, here is the plan.\n');
});

test('CodexOutputParser filters known metadata lines while keeping content', () => {
  const { parser, textChunks, reasoningMessages } = collectOutputs();

  parser.ingest('model: gpt-5\n');
  parser.ingest('[2024-05-01T12:00:00] thinking\nworkdir: /tmp/project\nOutline response.\n');
  parser.ingest('[2024-05-01T12:00:01] codex\nHello world!\n');
  parser.finalize();

  assert.deepEqual(reasoningMessages, ['Outline response.']);
  assert.strictEqual(textChunks.join(''), 'Hello world!\n');
});

test('CodexOutputParser filters config summary header block', () => {
  const { parser, textChunks, reasoningMessages } = collectOutputs();

  parser.ingest('[2024-05-01T12:00:00] OpenAI Codex v0.0.0 (research preview)\n');
  parser.ingest('--------\n');
  parser.ingest('workdir: /tmp/project\n');
  parser.ingest('model: gpt-5\n');
  parser.ingest('provider: openai\n');
  parser.ingest('sandbox: workspace-write\n');
  parser.ingest('[2024-05-01T12:00:01] thinking\nSketch plan.\n');
  parser.ingest('[2024-05-01T12:00:02] codex\nAll done.\n');
  parser.finalize();

  assert.deepEqual(reasoningMessages, ['Sketch plan.']);
  assert.strictEqual(textChunks.join(''), 'All done.\n');
});

test('CodexOutputParser handles chunk boundaries that split timestamp markers', () => {
  const { parser, textChunks, reasoningMessages } = collectOutputs();

  parser.ingest('[2024-05-');
  parser.ingest('01T12:00:00] thinking\nFirst step.\n[2024-05-01T12:00:01] cod');
  parser.ingest('ex\nAnswer piece');
  parser.finalize();

  assert.deepEqual(reasoningMessages, ['First step.']);
  assert.strictEqual(textChunks.join(''), 'Answer piece');
});

test('CodexOutputParser strips antml tool call payloads and retains following content', () => {
  const { parser, textChunks, reasoningMessages } = collectOutputs();

  parser.ingest('[2024-05-01T12:00:00] thinking\n<function_calls>\n<invoke name="shell"/>\n</antml:function_calls>\nContinue reasoning.\n');
  parser.ingest('[2024-05-01T12:00:01] codex\nFinal text after tool.\n');
  parser.finalize();

  assert.deepEqual(reasoningMessages, ['Continue reasoning.']);
  assert.strictEqual(textChunks.join(''), 'Final text after tool.\n');
});

test('CodexOutputParser skips user instructions block and flushes reasoning on finalize', () => {
  const { parser, textChunks, reasoningMessages } = collectOutputs();

  parser.ingest('[2024-05-01T12:00:00] User instructions:\nDo one thing.\nDo another.\n');
  parser.ingest('[2024-05-01T12:00:01] thinking\nDraft approach.\n');
  parser.finalize();

  assert.deepEqual(reasoningMessages, ['Draft approach.']);
  assert.strictEqual(textChunks.join(''), '');
});

test('CodexOutputParser handles antml blocks split across chunks', () => {
  const { parser, textChunks, reasoningMessages } = collectOutputs();

  parser.ingest('[2024-05-01T12:00:00] thinking\n<function_calls>\n<invoke name="shell"/');
  parser.ingest('>\n');
  parser.ingest('</antml:function_calls>\nReasoning continues.\n');
  parser.ingest('[2024-05-01T12:00:01] codex\nResponse after tool.\n');
  parser.finalize();

  assert.deepEqual(reasoningMessages, ['Reasoning continues.']);
  assert.strictEqual(textChunks.join(''), 'Response after tool.\n');
});

test('CodexOutputParser emits multiple reasoning segments', () => {
  const { parser, textChunks, reasoningMessages } = collectOutputs();

  parser.ingest('[2024-05-01T12:00:00] thinking\nFirst plan.\n');
  parser.ingest('[2024-05-01T12:00:01] codex\nPartial answer.\n');
  parser.ingest('[2024-05-01T12:00:02] thinking\nSecond plan.\n');
  parser.ingest('[2024-05-01T12:00:03] codex\nFinal answer.\n');
  parser.finalize();

  assert.deepEqual(reasoningMessages, ['First plan.', 'Second plan.']);
  assert.strictEqual(textChunks.join(''), 'Partial answer.\nFinal answer.\n');
});

test('CodexOutputParser handles real CLI transcript with tool output', () => {
  const { parser, textChunks, reasoningMessages } = collectOutputs();

  const transcript = `[2025-10-01T16:56:46] OpenAI Codex v0.42.0 (research preview)\n--------\nworkdir: /home/hammer/github/claudecodeui-add-codex-support\nmodel: gpt-5-codex\nprovider: openai\napproval: never\nsandbox: read-only\nreasoning effort: none\nreasoning summaries: auto\n--------\n[2025-10-01T16:56:46] User instructions:\nList the files in the current directory and then summarize them.\n\n[2025-10-01T16:56:49] thinking\n\n**Preparing to list files with shell**\n[2025-10-01T16:56:49] exec bash -lc ls in /home/hammer/github/claudecodeui-add-codex-support/.\n[2025-10-01T16:56:49] bash -lc ls succeeded in 19ms:\ndist\nindex.html\nLICENSE\nnode_modules\npackage.json\npackage-lock.json\npostcss.config.js\npublic\nREADME.md\nreference-material\nserver\nsrc\ntailwind.config.js\nvite.config.js\n[2025-10-01T16:56:49] tokens used: 628\n[2025-10-01T16:56:50] tokens used: 628\n\n[2025-10-01T16:56:51] thinking\n\n**Summarizing project files and directories**\n[2025-10-01T16:56:51] codex\n\nProject includes source code under \`src/\` with build config via \`vite.config.js\`, Tailwind (\`tailwind.config.js\`) and PostCSS (\`postcss.config.js\`). \`public/\` holds static assets, while \`dist/\` contains the built output. Backend or server utilities live in \`server/\`. Dependency management is through \`package.json\` and \`package-lock.json\`, with modules installed in \`node_modules/\`. Top-level docs: \`README.md\`, \`LICENSE\`, plus extra references in \`reference-material/\`. \`index.html\` is the main entry point for the Vite app.\n[2025-10-01T16:56:53] tokens used: 1,479\n`;

  for (let pos = 0; pos < transcript.length; pos += 37) {
    parser.ingest(transcript.slice(pos, pos + 37));
  }
  parser.finalize();

  assert.deepEqual(reasoningMessages, [
    '**Preparing to list files with shell**\n' +
      'dist\nindex.html\nLICENSE\nnode_modules\npackage.json\npackage-lock.json\npostcss.config.js\npublic\nREADME.md\nreference-material\nserver\nsrc\ntailwind.config.js\nvite.config.js\n\n\n**Summarizing project files and directories**'
  ]);

  assert.strictEqual(
    textChunks.join(''),
    '\nProject includes source code under `src/` with build config via `vite.config.js`, Tailwind (`tailwind.config.js`) and PostCSS (`postcss.config.js`). `public/` holds static assets, while `dist/` contains the built output. Backend or server utilities live in `server/`. Dependency management is through `package.json` and `package-lock.json`, with modules installed in `node_modules/`. Top-level docs: `README.md`, `LICENSE`, plus extra references in `reference-material/`. `index.html` is the main entry point for the Vite app.\n'
  );
});

const TIMESTAMP_LINE_REGEX = /^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\]\s*([\s\S]*)$/;

const ANTML_DELIMITERS = [
  { start: '<function_calls', end: '</antml:function_calls>' },
  { start: '<invoke', end: '</antml:invoke>' },
  { start: '<parameter', end: '</antml:parameter>' }
];

const METADATA_PREFIXES = [
  'model:',
  'provider:',
  'approval:',
  'sandbox:',
  'reasoning effort:',
  'reasoning summaries:',
  'tokens used:',
  'workdir:',
  'session:',
  'project:',
  'duration:',
  'run id:',
  'openai codex v'
];

const TOOL_META_PHRASES = [
  "i'll use the",
  "i'm going to use the",
  'let me use the',
  "i'll call the",
  'using the',
  'i need to use'
];

function stripAnsi(value) {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

function trimInternalWhitespace(block) {
  return block
    .split(/\r?\n/)
    .map(line => line.trimEnd())
    .join('\n')
    .trim();
}

export class CodexOutputParser {
  constructor({ onText = () => {}, onReasoning = () => {} } = {}) {
    this.onText = onText;
    this.onReasoning = onReasoning;

    this.buffer = '';
    this.mode = 'response';
    this.reasoningBuffer = '';
    this.skipUserInstructions = false;
    this.pendingAntmlEnd = null;
  }

  ingest(chunk) {
    if (!chunk) return;
    this.buffer += chunk;

    while (true) {
      const newlineIndex = this.buffer.indexOf('\n');
      if (newlineIndex === -1) break;

      const line = this.buffer.slice(0, newlineIndex + 1);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      this._handleLine(line);
    }
  }

  finalize() {
    if (this.buffer) {
      this._handleLine(this.buffer);
      this.buffer = '';
    }
    this._flushReasoning();
  }

  _handleLine(rawLine) {
    if (!rawLine) return;

    let line = stripAnsi(rawLine).replace(/\r/g, '');
    if (!line) return;

    line = this._stripAntml(line);
    if (!line) return;

    if (this.skipUserInstructions) {
      if (TIMESTAMP_LINE_REGEX.test(line)) {
        this.skipUserInstructions = false;
        this._handleLine(line);
      }
      return;
    }

    const timestampMatch = TIMESTAMP_LINE_REGEX.exec(line);
    if (timestampMatch) {
      const [, , rawContent = ''] = timestampMatch;
      const content = rawContent.trim();
      const lowered = content.toLowerCase();

      if (!content) {
        return;
      }

      if (lowered === 'thinking') {
        this.mode = 'thinking';
        return;
      }

      if (lowered === 'codex') {
        this._flushReasoning();
        this.mode = 'response';
        return;
      }

      if (lowered.startsWith('user instructions:')) {
        this.skipUserInstructions = true;
        return;
      }

      if (lowered.startsWith('exec ')) {
        return;
      }

      if (lowered.includes(' succeeded in ') || lowered.includes(' failed')) {
        return;
      }

      line = rawContent;
    }

    const trimmed = line.trim();
    const loweredTrimmed = trimmed.toLowerCase();

    if (!trimmed) {
      this._appendLine(line);
      return;
    }

    if (METADATA_PREFIXES.some(prefix => loweredTrimmed.startsWith(prefix))) {
      return;
    }

    if (/^[-=]{3,}\s*$/.test(trimmed)) {
      return;
    }

    if (TOOL_META_PHRASES.some(phrase => loweredTrimmed.startsWith(phrase))) {
      return;
    }

    this._appendLine(line);
  }

  _appendLine(line) {
    if (this.mode === 'thinking') {
      this.reasoningBuffer += line;
    } else {
      this.onText(line);
    }
  }

  _flushReasoning() {
    const cleaned = trimInternalWhitespace(this.reasoningBuffer);
    if (cleaned) {
      this.onReasoning(cleaned);
    }
    this.reasoningBuffer = '';
  }

  _stripAntml(line) {
    if (this.pendingAntmlEnd) {
      const lower = line.toLowerCase();
      const closingIndex = lower.indexOf(this.pendingAntmlEnd);
      if (closingIndex === -1) {
        return '';
      }

      line = line.slice(closingIndex + this.pendingAntmlEnd.length);
      this.pendingAntmlEnd = null;
      if (!line) {
        return '';
      }
    }

    let result = line;
    for (const { start, end } of ANTML_DELIMITERS) {
      const startToken = start.toLowerCase();
      const endToken = end.toLowerCase();

      let lower = result.toLowerCase();
      let startIdx = lower.indexOf(startToken);

      while (startIdx !== -1) {
        const endIdx = lower.indexOf(endToken, startIdx + startToken.length);

        if (endIdx === -1) {
          this.pendingAntmlEnd = endToken;
          result = result.slice(0, startIdx);
          return result;
        }

        result = result.slice(0, startIdx) + result.slice(endIdx + endToken.length);
        lower = result.toLowerCase();
        startIdx = lower.indexOf(startToken);
      }
    }

    return result;
  }
}

export default CodexOutputParser;

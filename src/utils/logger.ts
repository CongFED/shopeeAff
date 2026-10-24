export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

const LEVEL_NAMES: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: 'DEBUG',
  [LogLevel.INFO]: 'INFO',
  [LogLevel.WARN]: 'WARN',
  [LogLevel.ERROR]: 'ERROR',
};

class Logger {
  private level: LogLevel = LogLevel.INFO;

  setLevel(level: LogLevel | string) {
    if (typeof level === 'string') {
      const upper = level.toUpperCase();
      if (upper === 'DEBUG') this.level = LogLevel.DEBUG;
      else if (upper === 'WARN') this.level = LogLevel.WARN;
      else if (upper === 'ERROR') this.level = LogLevel.ERROR;
      else this.level = LogLevel.INFO;
    } else {
      this.level = level;
    }
  }

  private sanitize(message: string): string {
    // Redact tokens, secrets, cookies from logs
    return message
      .replace(/bot\d+:[A-Za-z0-9_-]{20,}/g, 'bot[REDACTED_TOKEN]')
      .replace(/([?&]token=)[^&]+/gi, '$1[REDACTED]')
      .replace(/([?&]secret=)[^&]+/gi, '$1[REDACTED]')
      .replace(/(Cookie:\s*)[^\r\n]+/gi, '$1[REDACTED_COOKIE]');
  }

  private format(level: LogLevel, message: string, meta?: any): string {
    const timestamp = new Date().toISOString();
    const tag = LEVEL_NAMES[level].padEnd(5);
    const sanitizedMsg = this.sanitize(message);
    const metaStr = meta !== undefined ? ` | ${JSON.stringify(meta)}` : '';
    return `[${timestamp}] [${tag}] ${sanitizedMsg}${metaStr}`;
  }

  debug(message: string, meta?: any) {
    if (this.level <= LogLevel.DEBUG) {
      console.debug(this.format(LogLevel.DEBUG, message, meta));
    }
  }

  info(message: string, meta?: any) {
    if (this.level <= LogLevel.INFO) {
      console.log(this.format(LogLevel.INFO, message, meta));
    }
  }

  warn(message: string, meta?: any) {
    if (this.level <= LogLevel.WARN) {
      console.warn(this.format(LogLevel.WARN, message, meta));
    }
  }

  error(message: string, err?: any) {
    if (this.level <= LogLevel.ERROR) {
      const errDetail = err instanceof Error ? { message: err.message, stack: err.stack } : err;
      console.error(this.format(LogLevel.ERROR, message, errDetail));
    }
  }
}

export const logger = new Logger();

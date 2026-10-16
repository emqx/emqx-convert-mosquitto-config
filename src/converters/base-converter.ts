import { booleanValue, integerValue } from '../mosquitto-parser.js';
import type {
  Directive,
  HoconObject,
  MosquittoConfig,
  Warning,
} from '../types.js';

export class ConversionContext {
  warnings: Warning[];
  disabledListeners: string[] = [];
  blockAllListeners = false;
  config: HoconObject = {};

  constructor(public readonly source: MosquittoConfig) {
    this.warnings = [...source.warnings];
  }

  warn(code: string, message: string, d?: Directive): void {
    this.warnings.push({
      code,
      message,
      ...(d && { source: d.source, line: d.line, directive: d.name }),
    });
  }
}

export class Settings {
  private values = new Map<string, Directive>();

  constructor(directives: Directive[], context: ConversionContext) {
    for (const d of directives) {
      if (this.values.has(d.name))
        context.warn(
          'DUPLICATE_DIRECTIVE',
          `Repeated ${d.name}; the last value is used. Check the source configuration.`,
          d
        );
      this.values.set(d.name, d);
    }
  }

  get(name: string): Directive | undefined {
    return this.values.get(name);
  }
  text(name: string): string | undefined {
    return this.get(name)?.value;
  }
  bool(name: string, fallback: boolean): boolean {
    const d = this.get(name);
    return d ? booleanValue(d) : fallback;
  }
  int(
    name: string,
    fallback: number,
    min = 0,
    max = Number.MAX_SAFE_INTEGER
  ): number {
    const d = this.get(name);
    return d ? integerValue(d, min, max) : fallback;
  }
}

export abstract class BaseConverter {
  abstract convert(context: ConversionContext): void;
}

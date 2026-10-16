import type { HoconObject, HoconValue, Warning } from './types.js';

export class HOCONGenerator {
  generate(config: HoconObject, warnings: Warning[] = []): string {
    const header = [
      '# Converted from Mosquitto 2.0.x to EMQX 6.2.3 HOCON.',
      '# Review migration warnings and file paths before applying to a fresh EMQX instance.',
      ...warnings.map((w) =>
        `# WARNING [${w.code}] ${w.source ? `${w.source}:${w.line}: ` : ''}${w.message}`.replace(
          /[\r\n\u2028\u2029]/g,
          ' '
        )
      ),
      '',
    ];
    return header.join('\n') + this.object(config, 0).join('\n') + '\n';
  }

  private object(obj: HoconObject, depth: number): string[] {
    const pad = '  '.repeat(depth);
    return Object.entries(obj).flatMap(([key, value]) => {
      const safeKey = /^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(key)
        ? key
        : JSON.stringify(key);
      if (typeof value === 'object' && !Array.isArray(value)) {
        return [
          `${pad}${safeKey} {`,
          ...this.object(value, depth + 1),
          `${pad}}`,
        ];
      }
      return [`${pad}${safeKey} = ${this.value(value, depth)}`];
    });
  }

  private value(value: HoconValue, depth: number): string {
    if (Array.isArray(value))
      return `[${value.map((v) => this.value(v, depth)).join(', ')}]`;
    if (typeof value === 'object')
      return `{\n${this.object(value, depth + 1).join('\n')}\n${'  '.repeat(depth)}}`;
    // JSON strings safely escape quotes, backslashes and control characters.
    return JSON.stringify(value);
  }
}

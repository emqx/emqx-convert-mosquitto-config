import { fail } from '../mosquitto-parser.js';
import type { HoconObject } from '../types.js';
import { BaseConverter, ConversionContext } from './base-converter.js';

export class LoggingConverter extends BaseConverter {
  convert(context: ConversionContext): void {
    const dests = context.source.globals.filter((d) => d.name === 'log_dest');
    const types = context.source.globals.filter((d) => d.name === 'log_type');
    if (!dests.length && !types.length) return;
    const levels: Record<string, string> = {
      error: 'error',
      warning: 'warning',
      notice: 'notice',
      information: 'info',
      debug: 'debug',
      all: 'debug',
      none: 'emergency',
    };
    const order = ['emergency', 'error', 'warning', 'notice', 'info', 'debug'];
    let level = types.length ? 'emergency' : 'info';
    for (const d of types) {
      if (d.value === 'none') {
        level = 'emergency';
      } else if (['subscribe', 'unsubscribe', 'websockets'].includes(d.value)) {
        context.warn(
          'LOG_EVENTS',
          'Mosquitto subscription/WebSocket log categories need EMQX event tracing.',
          d
        );
      } else if (!levels[d.value]) fail(d, 'unrecognized log type.');
      else if (order.indexOf(levels[d.value]!) > order.indexOf(level))
        level = levels[d.value]!;
    }
    if (types.length)
      context.warn(
        'LOG_LEVEL',
        'Mosquitto log categories are approximated by an EMQX severity threshold; emitted events may differ.',
        types[0]
      );
    const log: HoconObject = {
      console: { enable: dests.length === 0, level },
      file: { default: { enable: false } },
    };
    const consoleConfig = log.console as HoconObject;
    const fileConfig = log.file as HoconObject;
    for (const d of dests) {
      if (d.value === 'stdout' || d.value === 'stderr')
        consoleConfig.enable = true;
      else if (/^file\s+\S/.test(d.value)) {
        if ((fileConfig.default as HoconObject).enable)
          fail(d, 'only one log file destination is supported.');
        fileConfig.default = {
          enable: true,
          path: d.value.replace(/^file\s+/, ''),
          level,
        };
        context.warn(
          'LOG_FILE_PATH',
          'Ensure the log file directory exists and is writable by EMQX.',
          d
        );
      } else if (['syslog', 'topic', 'dlt', 'android'].includes(d.value))
        context.warn(
          'LOG_DESTINATION',
          `log_dest ${d.value} needs external log forwarding.`,
          d
        );
      else if (d.value === 'none') {
        consoleConfig.enable = false;
        fileConfig.default = { enable: false };
      } else fail(d, 'unrecognized log destination or missing file path.');
    }
    if (types.at(-1)?.value === 'none') {
      consoleConfig.enable = false;
      fileConfig.default = { enable: false };
    }
    context.config.log = log;
  }
}

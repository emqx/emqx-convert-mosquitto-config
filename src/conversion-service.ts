import { MosquittoParser } from './mosquitto-parser.js';
import { MosquittoToEMQXConverter } from './converters/mosquitto-to-emqx-converter.js';
import { HOCONGenerator } from './hocon-generator.js';
import type { ConversionResult, ParseOptions } from './types.js';

export class ConversionService {
  convertConfigToHocon(
    content: string,
    options: ParseOptions = {}
  ): ConversionResult {
    try {
      const parsed = new MosquittoParser().parse(content, options);
      const { config, warnings, disabledListeners } =
        new MosquittoToEMQXConverter().convert(parsed);
      return {
        hocon: new HOCONGenerator().generate(config, warnings),
        config,
        warnings,
        disabledListeners,
      };
    } catch (error) {
      return {
        hocon: '',
        warnings: [],
        disabledListeners: [],
        error:
          error instanceof Error ? error.message : 'Unknown conversion error',
      };
    }
  }
}

export type { ConversionResult, ParseOptions, Warning } from './types.js';

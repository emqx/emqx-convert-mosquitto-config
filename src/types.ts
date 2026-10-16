export interface Directive {
  name: string;
  value: string;
  source: string;
  line: number;
}

export interface SourceFile {
  name: string;
  content: string;
}

export interface ParseOptions {
  source?: string;
  /** Resolve explicitly requested include directories; only the CLI supplies this. */
  resolveInclude?: (directory: string, from: string) => SourceFile[];
}

export interface MosquittoListener {
  port: number;
  host?: string;
  origin?: Directive;
  settings: Directive[];
  security: Directive[];
  implicit?: boolean;
}

export interface MosquittoBridge {
  origin: Directive;
  settings: Directive[];
}

export interface MosquittoConfig {
  globals: Directive[];
  security: Directive[];
  listeners: MosquittoListener[];
  bridges: MosquittoBridge[];
  perListenerSettings: boolean;
  warnings: Warning[];
}

export interface Warning {
  code: string;
  message: string;
  source?: string;
  line?: number;
  directive?: string;
}

export type HoconValue = string | number | boolean | HoconObject | HoconValue[];
export interface HoconObject {
  [key: string]: HoconValue;
}

export interface ConversionResult {
  hocon: string;
  warnings: Warning[];
  /** Listeners that must be reviewed before enabling them. */
  disabledListeners: string[];
  config?: HoconObject;
  error?: string;
}

#!/usr/bin/env node
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  realpathSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { resolve, dirname, basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConversionService } from './conversion-service.js';
import type { ParseOptions } from './types.js';

const HELP = `Mosquitto to EMQX Configuration Converter

Usage: mosquitto-convert <mosquitto.conf|-> [options]

  -o, --output <path>   Write HOCON to a file (default: stdout)
  --include-dir        Load include_dir .conf files from local disk
  --base-dir <path>    Base for relative include_dir paths (default: cwd)
  --json               Emit HOCON, warnings and disabledListeners as JSON
  --strict             Exit 2 without writing output when there are warnings
  -h, --help           Show this help

Examples:
  mosquitto-convert mosquitto.conf -o emqx.hocon
  mosquitto-convert mosquitto.conf --include-dir --base-dir /etc/mosquitto
  cat mosquitto.conf | mosquitto-convert -

Targets Mosquitto 2.0.x -> EMQX 6.2.3. Review all migration warnings.
Password, ACL, plugin and certificate files are not read or imported.
`;

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
    process.stdout.write(HELP);
    return;
  }
  let input: string | undefined;
  let output: string | undefined;
  let baseDir = process.cwd();
  let includes = false;
  let json = false;
  let strict = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (['-o', '--output', '--base-dir'].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('-'))
        throw new Error(`${arg} requires a path.`);
      if (arg === '--base-dir') baseDir = resolve(value);
      else output = resolve(value);
    } else if (arg === '--include-dir') includes = true;
    else if (arg === '--json') json = true;
    else if (arg === '--strict') strict = true;
    else if (arg !== '-' && arg.startsWith('-'))
      throw new Error(`Unknown option: ${arg}`);
    else if (input) throw new Error('Only one input file is accepted.');
    else input = arg;
  }
  if (!input)
    throw new Error(
      'An input file or - for stdin is required. Use --help for usage.'
    );
  const inputPath = input === '-' ? undefined : resolve(input);
  const inputReal = inputPath ? realpathSync(inputPath) : undefined;
  if (output && inputReal) {
    let outputReal = output;
    try {
      outputReal = realpathSync(output);
    } catch {
      /* A new output file. */
    }
    if (outputReal === inputReal)
      throw new Error('Output must not overwrite the input configuration.');
  }
  let total = 0;
  let files = 0;
  const read = (path: string): string => {
    const stat = statSync(path);
    if (!stat.isFile()) throw new Error(`Not a regular file: ${path}`);
    total += stat.size;
    if (++files > 256 || total > 4 * 1024 * 1024)
      throw new Error('Input exceeds 256 files or 4 MiB.');
    return readFileSync(path, 'utf8');
  };
  const options: ParseOptions = { source: inputPath ?? 'stdin' };
  if (includes)
    options.resolveInclude = (directory) => {
      const path = resolve(baseDir, directory);
      return readdirSync(path, { withFileTypes: true })
        .filter(
          (entry) =>
            entry.name.endsWith('.conf') &&
            (entry.isFile() || entry.isSymbolicLink())
        )
        .map((entry) => {
          const name = join(path, entry.name);
          if (inputReal && realpathSync(name) === inputReal)
            throw new Error(
              'include_dir must not contain the main configuration file.'
            );
          return { name, content: read(name) };
        });
    };
  const content = inputPath ? read(inputPath) : readFileSync(0, 'utf8');
  const result = new ConversionService().convertConfigToHocon(content, options);
  if (result.error) throw new Error(result.error);
  for (const warning of result.warnings)
    process.stderr.write(
      `Warning [${warning.code}] ${warning.source ? `${warning.source}:${warning.line}: ` : ''}${warning.message}\n`
    );
  if (strict && result.warnings.length) {
    process.stderr.write(
      'Strict mode: output was not written because migration warnings remain.\n'
    );
    process.exitCode = 2;
    return;
  }
  const data = json ? JSON.stringify(result, null, 2) + '\n' : result.hocon;
  if (output) {
    const temporary = join(
      dirname(output),
      `.${basename(output)}.${randomUUID()}.tmp`
    );
    try {
      writeFileSync(temporary, data, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      renameSync(temporary, output);
    } finally {
      try {
        unlinkSync(temporary);
      } catch {
        /* Already renamed, or never created. */
      }
    }
    process.stderr.write(`Output written to ${output}\n`);
  } else process.stdout.write(data);
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `Error: ${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exitCode = 1;
}

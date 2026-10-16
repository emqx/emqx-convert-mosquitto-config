import type { MosquittoConfig } from '../types.js';
import { ConversionContext } from './base-converter.js';
import { MqttConverter } from './mqtt-converter.js';
import { ListenerConverter } from './listener-converter.js';
import { LoggingConverter } from './logging-converter.js';

export class MosquittoToEMQXConverter {
  convert(source: MosquittoConfig): ConversionContext {
    const context = new ConversionContext(source);
    new MqttConverter().convert(context);
    new ListenerConverter().convert(context);
    new LoggingConverter().convert(context);
    for (const bridge of source.bridges) {
      context.warn(
        'BRIDGE_MIGRATION',
        `Bridge ${JSON.stringify(bridge.origin.value)} is not converted. Create an EMQX MQTT connector, source/action and rules; review topic prefixes, QoS, retained messages, loop prevention and reconnect behavior. Bridge credentials are omitted.`,
        bridge.origin
      );
    }
    return context;
  }
}

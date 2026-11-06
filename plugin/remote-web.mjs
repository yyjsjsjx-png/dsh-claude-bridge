/** Keep native web configuration and policy, replacing only local provider readiness. */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolveDshModule } from './compat/resolve-dsh-module.mjs';
import { remoteWebRegistration } from '../src/native-web-activation.mjs';

const require = createRequire(resolveDshModule('@deepseek-ai/dsh-session'));
const native = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-tool-web')).href);

export const Config = native.Config;
export const inject = [...native.inject, 'claudeBridge'];

export function apply(ctx, config) {
  const tools = new Proxy(ctx.tools, { get(target, key) {
    if (key === 'register') return (definition, options) => target.register(definition,
      remoteWebRegistration(definition, options, context =>
        ctx.claudeBridge.backend?.nativeWebToolReady?.(context) ?? false));
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  return native.apply(new Proxy(ctx, { get(target, key) {
    if (key === 'tools') return tools;
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } }), config);
}

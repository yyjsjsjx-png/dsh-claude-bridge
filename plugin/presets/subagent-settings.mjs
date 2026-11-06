import { CLAUDE_PRESET } from '../policy.mjs';

const guards = new WeakMap();
export const SUBAGENT_SETTINGS_GATE = 'claudeSubagentPolicyGate';

/** Filter only the native settings entry's own listener, retaining its exact fiber owner. */
export function guardNativeSubagentSettings(context, entry) {
  let guard = guards.get(context);
  if (!guard) {
    const previous = Object.getOwnPropertyDescriptor(context, 'on');
    const on = function (event, listener, ...options) {
      const ownsSettings = this.fiber?.entry === entry && this.fiber.parent?.fiber?.entry !== entry;
      const callback = event === 'agent/created' && ownsSettings ? function (payload, ...args) {
        if (payload?.agent?.session?.header?.agentPreset === CLAUDE_PRESET) return;
        return listener.call(this, payload, ...args);
      } : listener;
      return this.events.on(event, callback, ...options);
    };
    Object.defineProperty(context, 'on', { value: on, configurable: true, writable: true });
    guard = { on, previous, references: 0 };
    guards.set(context, guard);
  }
  guard.references++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--guard.references) return;
    if (Object.getOwnPropertyDescriptor(context, 'on')?.value === guard.on) {
      if (guard.previous) Object.defineProperty(context, 'on', guard.previous);
      else delete context.on;
    }
    guards.delete(context);
  };
}

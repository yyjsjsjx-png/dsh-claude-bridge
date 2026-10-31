import { AgentPresetRegistry, RemoteError } from './compat/runtime.mjs';
import { makeLockedPresetRegistry } from './controller-guards.mjs';

export default makeLockedPresetRegistry(AgentPresetRegistry, RemoteError);

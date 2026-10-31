import { SessionController, RemoteError } from './compat/runtime.mjs';
import { makeGuardedSessionController } from './controller-guards.mjs';

export default makeGuardedSessionController(SessionController, RemoteError);

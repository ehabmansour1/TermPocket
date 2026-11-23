// Side-effect module, imported FIRST by the agent's entry points (index.js, ptyhost.js): every old
// VSCONTROL_* environment variable (TermPocket used to be called "VS Control") is copied to its
// TERMPOCKET_* name unless that is set, before any other module reads process.env.
import { applyLegacyEnv } from './config.js';

applyLegacyEnv(process.env);

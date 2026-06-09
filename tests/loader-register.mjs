// Registers the resolve hook in tests/loader.mjs for the test run.
// Used via:  node --import ./tests/loader-register.mjs --test tests/
import { register } from 'node:module';
register('./loader.mjs', import.meta.url);

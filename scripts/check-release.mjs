import {assertPublicRelease,releaseFingerprint} from './release-gate.mjs';
await assertPublicRelease();
console.log('Publication gate checked; source SHA256 '+await releaseFingerprint());

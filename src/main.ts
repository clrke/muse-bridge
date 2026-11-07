// Dev entry (`npm run dev` via tsx): same as the `muse-bridge` bin, without a build.
import { main } from './cli.js';

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

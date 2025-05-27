import { checkRepliesHeuristic } from './heu.js';

checkRepliesHeuristic()
  .then(() => {
    console.log('✅ Heuristic reply check complete.');
    process.exit(0);
  })
  .catch((err) => {
    console.error('❌ Error during heuristic reply check:', err);
    process.exit(1);
  });

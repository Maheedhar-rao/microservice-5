import { checkReplies } from './replyTracker.js';

checkReplies().then(() => {
  console.log('Done checking email replies.');
  process.exit();
});

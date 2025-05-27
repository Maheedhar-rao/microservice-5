import dotenv from 'dotenv';
import { checkReplies } from './replyTracker.js';

dotenv.config();

checkReplies().then(() => {
  console.log('✅ checkReplies ran via cron');
  process.exit();
}).catch(err => {
  console.error('❌ Error:', err);
  process.exit(1);
});

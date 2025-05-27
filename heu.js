import dotenv from 'dotenv';
import { google } from 'googleapis';
import { createClient } from '@supabase/supabase-js';
import { extractReplyBody } from './utils/extractBody.js';

dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const oAuth2Client = new google.auth.OAuth2(
  process.env.CLIENT_ID,
  process.env.CLIENT_SECRET,
  process.env.REDIRECT_URI
);
oAuth2Client.setCredentials({ refresh_token: process.env.REFRESH_TOKEN });

const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });

export async function checkRepliesHeuristic() {
  // 1. Get deals with all reply fields empty
  const { data: pendingDeals, error } = await supabase
    .from('Live submissions')
    .select('id, business_name, recipient_emails, submitted_at')
    .is('reply_status', null)
    .is('reply_body', null)
    .is('reply_date', null)
    .is('reply_history', null);

  if (!pendingDeals || pendingDeals.length === 0) {
    return console.log('✅ No unmatched deals found.');
  }

  // 2. Determine cutoff timestamp (latest deal)
  const lastSubmittedAt = new Date(Math.max(...pendingDeals.map(d => new Date(d.submitted_at).getTime())));
  const cutoff = lastSubmittedAt.getTime() - 30_000;

  // 3. Fetch Gmail messages
  const msgList = await gmail.users.messages.list({
    userId: 'me',
    maxResults: 100,
    q: 'newer_than:7d -in:spam -in:trash',
  });

  const messages = msgList.data.messages || [];

  for (const msg of messages) {
    const msgData = await gmail.users.messages.get({
      userId: 'me',
      id: msg.id,
      format: 'full',
    });

    const msgDate = parseInt(msgData.data.internalDate);
    if (msgDate <= cutoff) continue;

    const headers = Object.fromEntries(
      (msgData.data.payload.headers || []).map(h => [h.name.toLowerCase(), h.value])
    );

    // ✅ Skip threaded replies — only look for new thread responses
    const inReplyTo = headers['in-reply-to'];
    if (inReplyTo) continue;

    const from = headers['from'] || '';
    const subject = headers['subject'] || '';
    const date = headers['date'];
    const body = extractReplyBody(msgData.data.payload);

    for (const deal of pendingDeals) {
      const matchesLender = (deal.recipient_emails || []).some(email =>
        from.toLowerCase().includes(email.toLowerCase())
      );

      const matchesBusiness = subject.toLowerCase().includes(deal.business_name.toLowerCase()) ||
                              body.toLowerCase().includes(deal.business_name.toLowerCase());

      if (matchesLender && matchesBusiness) {
        const replyDate = new Date(date).toISOString();
        const newEntry = {
          timestamp: replyDate,
          sender: from,
          subject,
          body: body.slice(0, 2000),
        };

        await supabase.from('Live submissions').update({
          reply_status: 'Replied',
          reply_body: body.slice(0, 2000),
          reply_date: replyDate,
          reply_history: [newEntry],
        }).eq('id', deal.id);

        console.log(`✅ Heuristic reply matched: ${deal.business_name} from ${from}`);
        break;
      }
    }
  }

  console.log('✅ Heuristic scan complete.');
}

checkRepliesHeuristic().catch(console.error);

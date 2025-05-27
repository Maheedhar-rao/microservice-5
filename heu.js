import dotenv from 'dotenv';
import { google } from 'googleapis';
import { createClient } from '@supabase/supabase-js';
import { extractReplyBody } from './utils/extractBody.js';
import lenderEmailsRaw from './lender-emails.json' assert { type: 'json' };

dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const oAuth2Client = new google.auth.OAuth2(
  process.env.CLIENT_ID,
  process.env.CLIENT_SECRET,
  process.env.REDIRECT_URI
);
oAuth2Client.setCredentials({ refresh_token: process.env.REFRESH_TOKEN });

const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });

// Convert array of objects into a lookup map
const lenderEmailMap = {};
for (const entry of lenderEmailsRaw.emails) {
  lenderEmailMap[entry.lender_names] = entry.email
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);
}

export async function checkRepliesHeuristic() {
  const { data: pendingDeals } = await supabase
    .from('Live submissions')
    .select('id, business_name, lender_names, created_at')
    .is('reply_status', null)
    .is('reply_body', null)
    .is('reply_date', null);

  if (!pendingDeals || pendingDeals.length === 0) {
    console.log('✅ No unmatched deals found.');
    return;
  }

  const lastCreatedAt = new Date(Math.max(...pendingDeals.map(d => new Date(d.created_at).getTime())));
  const cutoff = lastCreatedAt.getTime() - 30_000;

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

    const inReplyTo = headers['in-reply-to'];
    if (inReplyTo) {
      console.log(`🧵 Skipping threaded message ${msg.id}`);
      continue;
    }

    const from = headers['from'] || '';
    const subject = headers['subject'] || '';
    const date = headers['date'];
    const body = extractReplyBody(msgData.data.payload);
    const actualEmail = from.match(/<([^>]+)>/)?.[1] || from;

    let matched = false;

    for (const deal of pendingDeals) {
      const knownEmails = lenderEmailMap[deal.lender_names] || [];

      const matchesLender = knownEmails.some(email =>
        actualEmail.toLowerCase() === email
      );

      if (!matchesLender) continue;

      const matchesBusiness = subject.toLowerCase().includes(deal.business_name.toLowerCase()) ||
                              body.toLowerCase().includes(deal.business_name.toLowerCase());

      if (!matchesBusiness) {
        console.log(`🔍 Skipping message ${msg.id}: business name "${deal.business_name}" not found in subject/body`);
        continue;
      }

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

      console.log(`✅ Heuristic match: ${deal.business_name} matched with ${actualEmail}`);
      matched = true;
      break;
    }

    if (!matched) {
      console.log(`⚠️ No match found for message ${msg.id} — scanned all pending deals`);
    }
  }

  console.log('✅ Heuristic scan complete.');
}

checkRepliesHeuristic().catch(console.error);

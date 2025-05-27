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

export async function checkReplies() {
  const { data } = await gmail.users.messages.list({
    userId: 'me',
    q: 'newer_than:7d',
    maxResults: 100,
  });

  const messages = data.messages || [];

  for (const msg of messages) {
    const metadataRes = await gmail.users.messages.get({
      userId: 'me',
      id: msg.id,
      format: 'metadata',
      metadataHeaders: ['In-Reply-To', 'Subject', 'From', 'Date'],
    });

    const headers = Object.fromEntries(
      (metadataRes.data.payload.headers || []).map(h => [h.name.toLowerCase(), h.value])
    );

    const inReplyTo = headers['in-reply-to'];
    const subject = headers['subject'];
    const from = headers['from'];
    const date = headers['date'];

    if (!inReplyTo) continue;

    const { data: matched, error } = await supabase
      .from('Live submissions')
      .select('*')
      .eq('message_id', inReplyTo);

    if (error || !matched || matched.length === 0) continue;

    const submission = matched[0];

    const fullReply = await gmail.users.messages.get({
      userId: 'me',
      id: msg.id,
      format: 'full',
    });

    const replyText = extractReplyBody(fullReply.data.payload);
    const replyDate = new Date(date).toISOString();

    const oldHistory = submission.reply_history || [];
    const newEntry = {
      timestamp: replyDate,
      sender: from,
      subject,
      body: replyText.slice(0, 2000),
    };

    const updatedHistory = [...oldHistory, newEntry];

    await supabase
      .from('Live submissions')
      .update({
        reply_status: 'Replied',
        reply_body: replyText.slice(0, 2000),
        reply_date: replyDate,
        reply_history: updatedHistory,
      })
      .eq('id', submission.id);

    console.log(` Reply matched and updated for: ${submission.business_name}`);
  }
}

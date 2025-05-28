import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const DRY_RUN = process.env.DRY_RUN === 'true'; // Set this in GitHub Secrets or .env

function isEmptyOrGeneric(text) {
  if (!text) return true;
  const lower = text.toLowerCase().trim();
  const genericPhrases = ['thanks', 'received', 'let me check', 'got it', 'noted', 'will get back'];
  return genericPhrases.some(p => lower.includes(p)) || lower.length < 10;
}

async function classifyReplies() {
  const { data: submissions, error } = await supabase
    .from('Live submissions')
    .select('*')
    .is('classified', null); // You must have this field or adjust logic

  if (error) {
    console.error('Error fetching submissions:', error);
    return;
  }

  console.log(`Processing ${submissions.length} submissions...`);

  for (const item of submissions) {
    let content = item.reply_body;

    if (isEmptyOrGeneric(content)) {
      if (!item.reply_history || item.reply_history === item.reply_body || isEmptyOrGeneric(item.reply_history)) {
        console.log(`Skipping generic or duplicate reply for ID ${item.id}`);
        await markClassified(item.id);
        await logSkip(item, 'Generic or empty fallback');
        continue;
      } else {
        content = item.reply_history;
      }
    }

    const messageText = `
Classify this lender reply:

"""
${content}
"""

Respond in strict JSON:
{
  "classification": "APPROVAL" | "DECLINE" | "NEUTRAL",
  "offer": "...",             // if approval
  "decline_reason": "..."     // if decline
}
`.trim();

    try {
      const thread = await openai.beta.threads.create();
      await openai.beta.threads.messages.create(thread.id, {
        role: 'user',
        content: messageText,
      });

      const run = await openai.beta.threads.runs.create(thread.id, {
        assistant_id: process.env.OPENAI_ASSISTANT_ID,
      });

      let runStatus;
      do {
        await new Promise(r => setTimeout(r, 1000));
        runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
      } while (runStatus.status !== 'completed' && runStatus.status !== 'failed');

      if (runStatus.status === 'failed') {
        throw new Error('Assistant run failed');
      }

      const messages = await openai.beta.threads.messages.list(thread.id);
      const final = messages.data.find(m => m.role === 'assistant');
      const contentRaw = final?.content?.[0]?.text?.value;
      const response = JSON.parse(contentRaw);

      if (!['APPROVAL', 'DECLINE'].includes(response.classification)) {
        console.log(` NEUTRAL reply for ID ${item.id}, skipping insert.`);
        await markClassified(item.id);
        continue;
      }

      if (DRY_RUN) {
        console.log(`[DRY RUN] Would insert ${response.classification} for ID ${item.id}:`, response);
      } else {
        await supabase.from('declines').insert([{
          business_name: item.business_name,
          lender_names: item.lender_name,
          offer: response.classification === 'APPROVAL' ? response.offer : null,
          decline_reason: response.classification === 'DECLINE' ? response.decline_reason : null
        }]);

        console.log(`✅ ${response.classification} logged for ID ${item.id}`);
      }

      if (!DRY_RUN) await markClassified(item.id);

    } catch (err) {
      console.error(`❌ Error processing ID ${item.id}:`, err.message);
      await logError(item, err.message);
    }
  }
}

async function markClassified(id) {
  await supabase.from('Live submissions').update({ classified: true }).eq('id', id);
}

async function logError(item, message) {
  await supabase.from('classifier_log').insert([{
    reply_id: item.id,
    type: 'error',
    message,
    data: item
  }]);
}

async function logSkip(item, message) {
  await supabase.from('classifier_log').insert([{
    reply_id: item.id,
    type: 'skip',
    message,
    data: item
  }]);
}

classifyReplies();

import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const DRY_RUN = process.env.DRY_RUN === 'true';

async function classifyReplies() {
  const { data: submissions, error } = await supabase
    .from('Live submissions')
    .select('*')
    .gt('created_at', new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString())
    .is('classified', null);

  if (error) {
    console.error('Error fetching submissions:', error);
    return;
  }

  console.log(`Processing ${submissions.length} submissions...`);

  for (const item of submissions) {
    let content = item.reply_body;

    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      if (item.reply_history && item.reply_history !== item.reply_body) {
        content = item.reply_history;
        console.log(`Using fallback reply_history for ID ${item.id}`);
      } else {
        console.log(`❌ No usable reply content for ID ${item.id} (${item.lender_names})`);
        await markClassified(item.id);
        await logSkip(item, 'Empty reply_body and no usable reply_history');
        continue;
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
  "decline_reason": "...",    // if decline
  "lender_name": "${item.lender_names || 'Unknown'}"
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
      const raw = final?.content?.[0]?.text?.value || '';
      console.log(`🧠 Raw assistant output for ID ${item.id} (${item.lender_names}):\n${raw}`);

      const clean = raw
        .replace(/```json/g, '')
        .replace(/```/g, '')
        .replace(/^`+|`+$/g, '')
        .trim();

      let response;
      try {
        response = JSON.parse(clean);
      } catch (err) {
        await logError(item, `Invalid JSON: ${clean}`);
        console.error(`❌ Failed to parse JSON for ID ${item.id}:`, err.message);
        continue;
      }

      if (!['APPROVAL', 'DECLINE'].includes(response.classification)) {
        console.log(`🤷‍♂️ NEUTRAL reply for ID ${item.id} (${item.lender_names}), skipping insert.`);
        await markClassified(item.id);
        continue;
      }

      if (DRY_RUN) {
        console.log(`[DRY RUN] Would insert ${response.classification} for ID ${item.id} (${item.lender_names}):`, response);
      } else {
        await supabase.from('declines').insert([{
          business_name: item.business_name,
          lender_names: item.lender_name || item.lender_names || 'Unknown',
          offer: response.classification === 'APPROVAL' ? response.offer : null,
          decline_reason:
            response.classification === 'DECLINE'
              ? response.decline_reason
              : response.classification === 'NEUTRAL'
              ? 'NEUTRAL'
              : null
        }]);

        console.log(`✅ ${response.classification} logged for ID ${item.id} (${item.lender_names})`);
      }

      if (!DRY_RUN) await markClassified(item.id);

    } catch (err) {
      console.error(`❌ Error processing ID ${item.id} (${item.lender_names}):`, err.message);
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

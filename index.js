import express from 'express';
import { google } from 'googleapis';
import { checkReplies } from './replyTracker.js';
import dotenv from 'dotenv';

dotenv.config();
const app = express();
const port = process.env.PORT || 3000;

const oAuth2Client = new google.auth.OAuth2(
  process.env.CLIENT_ID,
  process.env.CLIENT_SECRET,
  process.env.REDIRECT_URI
);

app.get('/auth', (req, res) => {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/gmail.readonly'],
  });

  res.redirect(authUrl);
});

app.get('/oauth2callback', async (req, res) => {
  const code = req.query.code;
  try {
    const { tokens } = await oAuth2Client.getToken(code);
    console.log('REFRESH TOKEN:', tokens.refresh_token);
    res.send(`✅ Refresh Token (copy & add to Render env):<br><code>${tokens.refresh_token}</code>`);
  } catch (err) {
    console.error(err);
    res.status(500).send('❌ Error exchanging code');
  }
});

app.get('/run-check', async (req, res) => {
  await checkReplies();
  res.send('✅ checkReplies executed');
});

app.get('/', (req, res) => {
  res.send('croccrm reply tracker is live.');
});

app.listen(port, () => {
  console.log(`✅ Server running at http://localhost:${port}`);
});

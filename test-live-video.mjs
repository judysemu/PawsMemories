import fs from 'fs';
import mysql from 'mysql2/promise';

const BASE_URL = 'https://pawsome3d.com/api';
const EMAIL = `test-video-bot-${Date.now()}@pawsome3d.com`;
const PASSWORD = 'TestPassword123!';

async function run() {
  console.log('1. Signing up user on LIVE site...');
  let res = await fetch(`${BASE_URL}/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, confirmPassword: PASSWORD, acceptedTerms: true })
  });
  
  if (!res.ok) {
    const err = await res.text();
    console.error('Signup failed:', err);
    return;
  }
  let json = await res.json();
  const token = json.token;
  console.log('Got token:', token ? 'yes' : 'no');

  console.log('2. Completing profile...');
  res = await fetch(`${BASE_URL}/auth/complete-profile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ fullName: 'Test Bot', birthdate: '1990-01-01', city: 'Test City', pets: [] })
  });
  if (!res.ok) {
    console.error('Profile complete failed:', await res.text());
  }

  console.log('3. Granting 1000 PupCoins via MySQL directly...');
  const pool = mysql.createPool({
    host: 'srv1544.hstgr.io',
    port: 3306,
    user: 'u876474286_robco_tech',
    password: 'Captivate2026!',
    database: 'u876474286_pawsome3d_app',
  });
  await pool.query('UPDATE users SET credits = 1000 WHERE email = ?', [EMAIL]);
  console.log('Credits granted.');

  console.log('4. Uploading photo...');
  const imgBuffer = fs.readFileSync('bostron-small.png');
  const imgBase64 = `data:image/png;base64,${imgBuffer.toString('base64')}`;
  
  res = await fetch(`${BASE_URL}/profile/photos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ image: imgBase64 })
  });
  if (!res.ok) {
    console.error('Upload failed:', await res.text());
    return;
  }
  json = await res.json();
  const creationId = json.photo.id;
  console.log('Photo uploaded, creation ID:', creationId);

  console.log('5. Triggering Fur Reels Generation...');
  const script = {
    id: "action-trailer",
    title: "Action Movie Trailer",
    genre: "Action",
    setting: "A neon-lit futuristic city at night.",
    characters: "A cool dog.",
    motions: "Dog is running fast.",
    stageDirections: ["Runs.", "Jumps.", "Lands.", "Looks."],
    lighting: "Neon lights.",
    filter: "Cyberpunk",
    camera: "Fast tracking shot.",
    voiceText: ""
  };
  
  res = await fetch(`${BASE_URL}/create-video`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ creationId, script, aspectRatio: '9:16' })
  });
  if (!res.ok) {
    console.error('Video generation failed:', await res.text());
    process.exit(1);
  }
  json = await res.json();
  const jobId = json.jobId;
  console.log('Job queued successfully! Job ID:', jobId);

  console.log('6. Polling for job status...');
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 5000));
    res = await fetch(`${BASE_URL}/jobs/${jobId}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    json = await res.json();
    console.log(`Status check ${i+1}:`, json.status);
    if (json.status === 'done') {
      console.log('SUCCESS! Video generated:', json.video_url || json.model_url);
      break;
    }
    if (json.status === 'failed') {
      console.error('FAILED!', json.error);
      break;
    }
  }

  pool.end();
}

run().catch(console.error);

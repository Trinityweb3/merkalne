/**
 * One-time Discord slash-command registration.
 *
 *   bun scripts/register-discord-commands.ts
 *
 * Requires in .env:
 *   DISCORD_APPLICATION_ID   — General Information → Application ID
 *   DISCORD_BOT_TOKEN        — Bot → Reset Token
 *
 * Creates three guild-agnostic (global) commands: /addjob, /jobs, /publish.
 * Global commands appear in every server the bot is installed in (up to 1 h
 * propagation); for instant testing in one server pass its id:
 *   bun scripts/register-discord-commands.ts <guild id>
 */
import { botEnv, discordRegistrationEnabled } from '../src/lib/bots/config'

const ADDJOB_OPTIONS = [
  { name: 'title', description: 'Job title', type: 3, required: true },
  { name: 'company', description: 'Company or project name', type: 3, required: true },
  { name: 'url', description: 'Apply URL (https://…)', type: 3, required: true },
  {
    name: 'section',
    description: 'Merklane section',
    type: 3,
    required: false,
    choices: [
      { name: 'Intern/Junior', value: 'intern-junior' },
      { name: 'Mid/Senior', value: 'mid-senior' },
      { name: 'Opportunities', value: 'opportunities' },
      { name: 'Markets', value: 'markets' },
      { name: 'Insights', value: 'insights' },
      { name: 'Blog', value: 'blog' },
    ],
  },
  { name: 'tags', description: 'Comma separated tags', type: 3, required: false },
  { name: 'body', description: 'Description / requirements', type: 3, required: false },
  { name: 'level', description: 'Junior / Mid / Senior / …', type: 3, required: false },
  { name: 'employment', description: 'Full-time / Part-time / …', type: 3, required: false },
  { name: 'workplace', description: 'Remote / Hybrid / On-site', type: 3, required: false },
  { name: 'salary', description: 'Salary range (display string)', type: 3, required: false },
  { name: 'location', description: 'Location', type: 3, required: false },
  { name: 'stack', description: 'Stack summary, e.g. Rust / Solana', type: 3, required: false },
  { name: 'publish', description: 'yes = publish immediately (default: draft)', type: 3, required: false },
]

const COMMANDS = [
  {
    name: 'addjob',
    description: 'Add a job posting to Merklane (admin)',
    type: 1,
    options: ADDJOB_OPTIONS,
  },
  { name: 'jobs', description: 'List recent Merklane postings (admin)', type: 1 },
  { name: 'publish', description: 'Publish a draft posting (admin)', type: 1, options: [{ name: 'id', description: 'Job id from /jobs', type: 3, required: true }] },
]

async function main() {
  if (!discordRegistrationEnabled()) {
    console.error(
      'Missing DISCORD_APPLICATION_ID, DISCORD_BOT_PUBLIC_KEY or DISCORD_BOT_TOKEN in the environment.\n' +
        'Set them in .env (see .env.example) and try again.',
    )
    process.exit(1)
  }

  const guildId = process.argv[2]
  const endpoint = guildId
    ? `https://discord.com/api/v10/applications/${botEnv.DISCORD_APPLICATION_ID}/guilds/${guildId}/commands`
    : `https://discord.com/api/v10/applications/${botEnv.DISCORD_APPLICATION_ID}/commands`

  const res = await fetch(endpoint, {
    method: 'PUT',
    headers: {
      Authorization: `Bot ${botEnv.DISCORD_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(COMMANDS),
  })

  if (res.ok) {
    console.log(`✅ Registered ${COMMANDS.length} commands (${guildId ? `guild ${guildId}` : 'global — may take up to 1 h to appear'}):`)
    for (const cmd of COMMANDS) console.log(`   /${cmd.name}`)
    console.log(`\nInteractions endpoint (set in the Discord portal): ${botEnv.APP_URL}/api/webhooks/discord`)
  } else {
    const body = await res.text().catch(() => '')
    console.error(`❌ Registration failed: HTTP ${res.status}\n${body.slice(0, 500)}`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

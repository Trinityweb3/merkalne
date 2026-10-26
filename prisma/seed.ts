/**
 * Seed: recreates the reference preview dataset (and a couple of extra
 * realistic items) so a fresh deployment matches the Merklane preview.
 *
 * Usage:
 *   DATABASE_URL="file:./db/custom.db" DATABASE_PROVIDER=sqlite \
 *     bun prisma/seed.ts            # local SQLite preview
 *   DATABASE_URL="postgresql://…" bun prisma/seed.ts   # production (docker exec)
 */
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'

const prisma = new PrismaClient()

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000)

interface SeedPost {
  slug: string
  section: string
  kind: string | null
  title: string
  company: string | null
  location: string | null
  workplace: string | null
  employment: string | null
  level: string | null
  salary: string | null
  stack: string | null
  body: string
  applyUrl?: string
  originalUrl?: string
  tags: string[]
  views: number
  likeCount: number
  dislikeCount: number
  addedHoursAgo: number
}

const POSTS: SeedPost[] = [
  {
    slug: 'empire-junior-analyst',
    section: 'intern-junior',
    kind: 'Job',
    title: 'Junior Crypto Analyst & Trader',
    company: 'Empire Assets',
    location: 'Remote · Global',
    workplace: 'Remote',
    employment: 'Part-time',
    level: 'Junior',
    salary: null,
    stack: 'Trading / Market analytics',
    body: `Empire Assets is looking for a junior analyst to join the trading desk.

**What you will do**

- Monitor spot and derivatives markets across major exchanges
- Summarise order-flow, funding and open-position changes into short desk notes
- Maintain watchlists and alert thresholds for the traders you support
- Backtest simple signal ideas with the team's Python notebooks

**What we expect**

- Solid understanding of market structure: order books, funding, liquidations
- Comfort with Excel and at least basic Python (pandas)
- Availability for 20–25 hours per week, including some weekend windows
- Fluency in written English

**Compensation**

Compensation details are shared during the interview. Nothing is required to purchase in order to apply — any request for payment is a scam.

Apply: https://empire-assets.example.com/careers/junior-analyst`,
    applyUrl: 'https://empire-assets.example.com/careers/junior-analyst',
    tags: ['Crypto', 'Trading', 'Junior'],
    views: 412,
    likeCount: 38,
    dislikeCount: 2,
    addedHoursAgo: 1,
  },
  {
    slug: 'frontend-intern',
    section: 'intern-junior',
    kind: 'Internship',
    title: 'Frontend Engineering Intern',
    company: 'Orbit Labs',
    location: 'Remote · Global',
    workplace: 'Remote',
    employment: 'Internship',
    level: 'Intern',
    salary: '$1,200 / month',
    stack: 'React / TypeScript',
    body: `Orbit Labs builds open analytics dashboards for on-chain data. We are opening one internship seat for a frontend engineer who wants to ship real features in production.

**Your work**

- Build and polish React components used by thousands of daily visitors
- Turn Figma designs into accessible, responsive interfaces
- Write small TypeScript utilities and fix bugs found by the community
- Join weekly reviews where your code is discussed respectfully

**Stack**

React, TypeScript, Tailwind CSS, Vite. No blockchain knowledge required — you will learn the on-chain part with the team.

**Compensation**

$1,200 per month, 20 hours per week, fully remote. Internships can convert to junior roles based on performance.

Apply: https://orbit-labs.example.com/jobs/frontend-intern`,
    applyUrl: 'https://orbit-labs.example.com/jobs/frontend-intern',
    tags: ['Frontend', 'Intern', 'React'],
    views: 638,
    likeCount: 61,
    dislikeCount: 1,
    addedHoursAgo: 3,
  },
  {
    slug: 'junior-data',
    section: 'intern-junior',
    kind: 'Job',
    title: 'Junior On-chain Data Analyst',
    company: 'Atlas Research',
    location: 'Remote · Europe',
    workplace: 'Remote',
    employment: 'Full-time',
    level: 'Junior',
    salary: null,
    stack: 'SQL / Python',
    body: `Atlas Research publishes institutional-grade reports on DeFi activity. We are hiring a junior analyst to work directly with our research leads.

**Responsibilities**

- Query and clean on-chain data using SQL and Python
- Track protocol metrics: TVL composition, user retention, fee flows
- Prepare charts and tables for published research
- Document data pipelines so the whole team can reproduce your numbers

**Requirements**

- Strong SQL; Python for analysis (pandas or polars)
- Curiosity about DeFi mechanics beyond the headlines
- Working language: English

Salary is not provided in this listing — it will be discussed during the process based on experience.

Apply: https://atlas-research.example.com/careers`,
    applyUrl: 'https://atlas-research.example.com/careers',
    tags: ['Data', 'DeFi', 'Junior'],
    views: 291,
    likeCount: 24,
    dislikeCount: 0,
    addedHoursAgo: 5,
  },
  {
    slug: 'okx-institutional-product',
    section: 'mid-senior',
    kind: 'Job',
    title: 'Product Manager / Director, Institutional Product',
    company: 'OKX',
    location: 'Hong Kong / Singapore',
    workplace: 'On-site',
    employment: 'Full-time',
    level: 'Senior / Director',
    salary: null,
    stack: 'Custody / Brokerage / AI',
    body: `OKX is strengthening the institutional product group covering custody, brokerage and trading infrastructure.

**The role**

- Own the roadmap for institutional custody and brokerage capabilities
- Work with compliance, engineering and institutional clients across APAC
- Translate complex regulatory requirements into shippable product increments
- Partner with the AI team on tooling that automates client onboarding checks

**Requirements**

- 5+ years in product management, ideally in digital assets, custody or prime brokerage
- Deep understanding of KYB/KYC flows and institutional trading needs
- Experience shipping in regulated environments
- Based in (or willing to relocate to) Hong Kong or Singapore; work authorisation required

Compensation is competitive and discussed individually.

Apply: https://okx.example.com/careers/institutional-product
Original post: https://okx.example.com/careers/institutional-product`,
    applyUrl: 'https://okx.example.com/careers/institutional-product',
    originalUrl: 'https://okx.example.com/careers/institutional-product',
    tags: ['Product', 'Custody', 'Crypto'],
    views: 733,
    likeCount: 44,
    dislikeCount: 3,
    addedHoursAgo: 2,
  },
  {
    slug: 'rust-engineer',
    section: 'mid-senior',
    kind: 'Job',
    title: 'Senior Rust Engineer',
    company: 'Northstar Protocol',
    location: 'Remote · Europe',
    workplace: 'Remote',
    employment: 'Full-time',
    level: 'Senior',
    salary: '$120,000–$160,000 / year',
    stack: 'Rust / Solana',
    body: `Northstar Protocol is building a liquidity layer on Solana. We are looking for a senior Rust engineer to own core protocol components.

**What you will build**

- On-chain programs (Anchor framework) with strict test coverage
- Off-chain matching and market-making services in Tokio-based Rust
- Performance tooling: profiling, fuzzing, chaos tests

**Requirements**

- 4+ years of Rust in production systems
- Experience with Solana programs or comparable low-latency systems
- Care about correctness: formal reviews, property tests, adversarial thinking
- Timezone overlap with Europe

$120,000–$160,000 per year plus token-based bonus, paid in stablecoins if preferred.

Apply: https://northstar.example.com/jobs/rust-engineer`,
    applyUrl: 'https://northstar.example.com/jobs/rust-engineer',
    tags: ['Rust', 'Solana', 'Backend'],
    views: 522,
    likeCount: 57,
    dislikeCount: 1,
    addedHoursAgo: 4,
  },
  {
    slug: 'community-lead',
    section: 'mid-senior',
    kind: 'Job',
    title: 'Community & Content Lead',
    company: 'Signal Collective',
    location: 'Remote · Global',
    workplace: 'Remote',
    employment: 'Full-time',
    level: 'Lead',
    salary: '$3,000–$4,500 / month',
    stack: 'Community / Content',
    body: `Signal Collective runs research channels read by 40,000 Web3 professionals. We need a lead who cares about quality over hype.

**Your mandate**

- Own the content calendar across Telegram, X and the Merklane blog
- Manage 6–8 moderators and contributors across time zones
- Turn research notes into clear briefings, with sources always linked
- Keep the community scam-free: verification standards, escalation rules

**You**

- 3+ years running technical communities (crypto, dev tools or research)
- Excellent written English; a portfolio of posts you are proud of
- Allergic to shilling; comfortable saying "we don't know yet"

$3,000–$4,500 per month depending on experience, fully remote.

Apply: https://signal-collective.example.com/join`,
    applyUrl: 'https://signal-collective.example.com/join',
    tags: ['Community', 'Marketing', 'Remote'],
    views: 344,
    likeCount: 29,
    dislikeCount: 2,
    addedHoursAgo: 6,
  },
  {
    slug: 'orbit-testnet',
    section: 'opportunities',
    kind: 'Testnet',
    title: 'Orbit testnet: the starter checklist',
    company: 'Orbit Network',
    location: 'Ethereum',
    workplace: null,
    employment: null,
    level: null,
    salary: null,
    stack: null,
    body: `A practical checklist for exploring the Orbit testnet before its mainnet launch.

**Checklist**

1. Request test ETH from the faucet (link in the official announcement only)
2. Bridge a small amount to Orbit using the official bridge UI
3. Try one swap on the flagship testnet DEX and confirm the explorer shows it
4. Delegate to a testnet validator to see how staking receipts work
5. Optional: deploy a hello-world contract with the provided template

**What you need**

- A burner wallet you never use for real funds
- About 30 minutes
- Healthy scepticism: any DM promising "guaranteed allocation" for bridging is not from Orbit

The testnet ends October 18, 2026. Participation details and potential recognition are described in the official announcement — nothing here is a promise of payment.

Original post: https://orbit-network.example.com/testnet`,
    originalUrl: 'https://orbit-network.example.com/testnet',
    tags: ['Testnet', 'Ethereum'],
    views: 810,
    likeCount: 72,
    dislikeCount: 4,
    addedHoursAgo: 2,
  },
  {
    slug: 'builder-quest',
    section: 'opportunities',
    kind: 'Quest',
    title: 'Builder quest: learn, ship and document',
    company: 'Builder Guild',
    location: 'Solana',
    workplace: null,
    employment: null,
    level: null,
    salary: null,
    stack: null,
    body: `A sample developer quest focused on building a small application and documenting what you learned.

**How it works**

- Pick one of the three starter briefs (NFT gate, escrow, memecoin dashboard)
- Ship a working demo to GitHub with a README that explains your choices
- Post the demo link in the quest channel before the deadline
- Peer review: comment on two other submissions

**Recognition**

Outstanding submissions are highlighted in the guild digest. There is no cash reward attached to this sample quest — any message asking for a fee to participate is a scam.

Original post: https://builder-guild.example.com/quests/builder-quest`,
    originalUrl: 'https://builder-guild.example.com/quests/builder-quest',
    tags: ['Quest', 'Solana', 'Builders'],
    views: 397,
    likeCount: 41,
    dislikeCount: 1,
    addedHoursAgo: 4,
  },
  {
    slug: 'learn-earn',
    section: 'opportunities',
    kind: 'Learn & Earn',
    title: 'Learn & Earn: wallet security essentials',
    company: 'Open Learning',
    location: 'Ethereum',
    workplace: null,
    employment: null,
    level: null,
    salary: null,
    stack: null,
    body: `A sample learning activity about wallet security and transaction permissions.

**Modules**

1. How seed phrases work and why nobody may ever ask for yours
2. Reading a transaction before signing: approvals, spend limits, delegate calls
3. Hardware wallets: what they protect and what they do not
4. Revoking approvals — and making revocation a monthly habit
5. Recognising drainer signatures in the wild

Each module ends with a short quiz. Complete all five to mark the activity as done. Educational content only — no tokens are distributed for this sample activity.

Original post: https://open-learning.example.com/courses/wallet-security`,
    originalUrl: 'https://open-learning.example.com/courses/wallet-security',
    tags: ['Education', 'Security'],
    views: 655,
    likeCount: 88,
    dislikeCount: 2,
    addedHoursAgo: 8,
  },
  {
    slug: 'btc-volume',
    section: 'markets',
    kind: 'Volume alert',
    title: 'BTC volume expands as market activity picks up',
    company: 'Bitcoin',
    location: 'Bitcoin',
    workplace: null,
    employment: null,
    level: null,
    salary: null,
    stack: null,
    body: `A sample snapshot of a Bitcoin volume event.

Spot volumes across major venues expanded over the past 24 hours while price stayed inside its recent range. Sustained range-plus-volume often precedes a directional move, but it says nothing about the direction — positioning data and funding tell the sharper part of that story.

**What to watch next**

- Whether volume expands on continuation days or fades back to baseline
- Funding rates on perpetuals (crowded longs vs shorts)
- Open interest changes reported by the exchanges themselves

This is a fictional example used for the interactive preview; figures are not live market data. Distinguish confirmed project updates from speculation and review the original sources before acting.`,
    tags: ['BTC', 'Volume', 'Markets'],
    views: 921,
    likeCount: 64,
    dislikeCount: 5,
    addedHoursAgo: 1,
  },
  {
    slug: 'sol-market',
    section: 'markets',
    kind: 'Analysis',
    title: 'SOL market structure: levels to monitor',
    company: 'Solana',
    location: 'Solana',
    workplace: null,
    employment: null,
    level: null,
    salary: null,
    stack: null,
    body: `A sample research note on Solana market structure.

SOL has been compressing into a tighter range over the past two weeks, with lower highs and higher lows converging. Volume dries up near the range extremes, which typically means the market is waiting for a catalyst rather than rejecting the levels outright.

**Levels worth marking**

- Range high: prior swing high plus the volume shelf above it
- Range low: the level defended three times with visible spot absorption
- Mid-range: mean reversion magnet for intraday moves

This note is a fictional sample for the interactive preview, not live market data or financial advice. A price movement is a starting point for research, not a conclusion.`,
    tags: ['SOL', 'Analysis'],
    views: 486,
    likeCount: 39,
    dislikeCount: 3,
    addedHoursAgo: 5,
  },
  {
    slug: 'eth-event',
    section: 'markets',
    kind: 'News',
    title: 'ETH ecosystem update: reading the signals',
    company: 'Ethereum',
    location: 'Ethereum',
    workplace: null,
    employment: null,
    level: null,
    salary: null,
    stack: null,
    body: `A sample Ethereum ecosystem briefing.

Three types of "updates" circulate every week, and treating them the same way is expensive:

- **Confirmed**: changes shipped in client releases, visible on-chain, announced on official channels
- **Planned**: roadmap items with agreed specs — timing always slips
- **Speculation**: "sources say" posts that move prices and deny later

This sample briefing demonstrates the Merklane format: what is known, what is planned, what is only rumour — with the original sources linked so you can verify each claim yourself. Distinguish confirmed project updates from speculation and review the original sources.`,
    tags: ['ETH', 'Ethereum', 'News'],
    views: 534,
    likeCount: 47,
    dislikeCount: 2,
    addedHoursAgo: 7,
  },
  {
    slug: 'remote-cv',
    section: 'insights',
    kind: 'Career guide',
    title: 'How to make your Web3 CV easier to evaluate',
    company: 'Merklane',
    location: null,
    workplace: null,
    employment: null,
    level: null,
    salary: null,
    stack: null,
    body: `A useful CV makes your work easy to understand. In Web3, where credentials are chaotic and portfolios matter more than diplomas, evaluators spend ninety seconds deciding whether to read further. Here is how to survive those ninety seconds.

**Lead with proof, not adjectives**

Replace "experienced DeFi trader" with "ran a 6-figure book for 18 months; max drawdown 12%; full trade log available". Numbers and artefacts beat descriptions. Links to repos, threads, dashboards or write-ups do more than any paragraph.

**Structure that works**

- One page. Two only if you genuinely cannot cut
- Roles in reverse-chronological order with dates and scope
- A "Proof" section: GitHub, Dune, published research, talks
- Wallet or ENS address only if it carries history you are proud of

**Remote-specific signals**

For remote roles, add your timezone, overlap hours you offer and async communication habits. Teams hire for reliability across distance; showing how you work remotely is as important as what you built.`,
    tags: ['Career', 'CV', 'Remote'],
    views: 762,
    likeCount: 96,
    dislikeCount: 3,
    addedHoursAgo: 3,
  },
  {
    slug: 'frontend-learning',
    section: 'insights',
    kind: 'Career guide',
    title: 'From learning React to your first Web3 frontend role',
    company: 'Merklane',
    location: null,
    workplace: null,
    employment: null,
    level: null,
    salary: null,
    stack: 'React / TypeScript',
    body: `Frontend intern applications benefit from a focused portfolio. The gap between "finished a course" and "ready to be hired" is filled with shipped, breakable, real things.

**A portfolio that actually helps**

- One polished app (your best work) rather than five tutorials
- One experiment that connects to a chain: read-only is fine — a token-gated page, a wallet balance widget
- A short write-up for each: what it does, what was hard, what you would change

**Skills that separate candidates**

- TypeScript fundamentals beyond annotations: unions, narrowing, generics
- Reading documentation instead of copying Stack Exchange answers
- Accessibility basics: keyboard paths, labels, contrast

**How to apply**

Reference the Merklane Intern/Junior section daily, apply within 48 hours of a listing appearing, and attach the write-up — evaluators read those first.`,
    tags: ['Frontend', 'Intern', 'Career'],
    views: 591,
    likeCount: 71,
    dislikeCount: 1,
    addedHoursAgo: 9,
  },
  {
    slug: 'market-context',
    section: 'insights',
    kind: 'Research',
    title: 'Why a token signal needs context',
    company: 'Merklane',
    location: null,
    workplace: null,
    employment: null,
    level: null,
    salary: null,
    stack: null,
    body: `A price movement is a starting point for research, not a conclusion.

Every week a token moves 20% and the timeline invents a reason within minutes. Sometimes the reason is real; usually it is a story fitted to the candles. The difference matters, and it is checkable.

**A minimum context checklist**

- What was the expected event calendar (unlocks, upgrades, listings) before the move?
- Did related assets move together (sector rotation) or alone (idiosyncratic)?
- Where did the volume come from: one venue, one region, or broadly?
- Is there an on-chain footprint: large transfers before the move?

**The habit that compounds**

Write one paragraph per signal you trade: what you believed, what would falsify it, what actually happened. After three months you have a personal dataset that no feed can replace. That is the actual edge — not speed, context.`,
    tags: ['Markets', 'Research'],
    views: 402,
    likeCount: 52,
    dislikeCount: 2,
    addedHoursAgo: 11,
  },
  {
    slug: 'welcome-to-merklane-blog',
    section: 'blog',
    kind: 'Article',
    title: 'Welcome to the Merklane community Blog',
    company: null,
    location: null,
    workplace: null,
    employment: null,
    level: null,
    salary: null,
    stack: null,
    body: `This is the community Blog — free for every registered user.

**What belongs here**

- Your experience with a protocol, tool or hiring process
- Tutorials you tested yourself
- Opinions with arguments, clearly labelled as opinions

**What does not**

- Paid promotions disguised as reviews
- Financial advice or "guaranteed" anything
- Content you did not write

Drafts stay private until you publish. Published posts are readable by anyone with the link but excluded from the main Merklane search and search engines — this is the Blog policy from day one.

Write your first post from the profile page (the “+” next to Blog in the menu works too).`,
    tags: ['Meta', 'Welcome'],
    views: 148,
    likeCount: 22,
    dislikeCount: 0,
    addedHoursAgo: 24,
  },
]

async function main() {
  console.log('Seeding Merklane…')

  // Demo accounts (only if absent — idempotent seed).
  const adminEmail = 'admin@merklane.dev'
  let admin = await prisma.user.findUnique({ where: { email: adminEmail } })
  if (!admin) {
    admin = await prisma.user.create({
      data: {
        email: adminEmail,
        name: 'Ivan Z.',
        role: 'admin',
        emailVerified: new Date(),
        // Password: "MerklaneAdmin2026" — change on any real deployment.
        passwordHash: await bcrypt.hash('MerklaneAdmin2026', 12),
      },
    })
    console.log('  admin account:', adminEmail, '(password: MerklaneAdmin2026)')
  }

  let author = await prisma.user.findUnique({ where: { email: 'blogger@merklane.dev' } })
  if (!author) {
    author = await prisma.user.create({
      data: {
        email: 'blogger@merklane.dev',
        name: 'Ola K.',
        emailVerified: new Date(),
        passwordHash: await bcrypt.hash('MerklaneBlogger2026', 12),
        bio: 'Frontend developer exploring Solana tooling. Writing about what I build.',
      },
    })
  }

  for (const seed of POSTS) {
    const existing = await prisma.post.findUnique({ where: { slug: seed.slug } })
    if (existing) continue
    const publishedAt = hoursAgo(seed.addedHoursAgo)
    await prisma.post.create({
      data: {
        slug: seed.slug,
        section: seed.section,
        kind: seed.kind,
        title: seed.title,
        company: seed.company,
        location: seed.location,
        workplace: seed.workplace,
        employment: seed.employment,
        level: seed.level,
        salary: seed.salary,
        stack: seed.stack,
        body: seed.body,
        applyUrl: seed.applyUrl ?? null,
        originalUrl: seed.originalUrl ?? null,
        tags: seed.tags.join(','),
        status: 'published',
        authorId: seed.section === 'blog' ? author.id : admin.id,
        publishedAt,
        views: seed.views,
        likeCount: seed.likeCount,
        dislikeCount: seed.dislikeCount,
      },
    })
    console.log(`  post: ${seed.slug}`)
  }

  console.log('Seed complete.')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())

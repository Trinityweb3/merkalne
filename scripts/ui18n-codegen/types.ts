/**
 * Shape of the NEW UI-i18n dictionary content injected into every locale file
 * (src/i18n/messages/*.ts) by inject.ts. The English data (en.ts) is the
 * reference; every locale data file is typed against this interface so
 * TypeScript proves key-completeness before anything touches the dictionaries.
 */

export interface HeroMessages {
  eyebrow: string
  title: string
  subtitle: string
}

export interface QuickLinksMessages {
  remoteJobs: string
  frontendIntern: string
  solana: string
  btcVolume: string
  addedToday: string
}

export interface SectionsMessages {
  internJuniorDesc: string
  midSeniorDesc: string
  opportunitiesDesc: string
  marketsDesc: string
  insightsDesc: string
  blogDesc: string
  emptyEditorial: string
  emptyBlog: string
  emptyFiltered: string
  filterType: string
  filterActivity: string
  filterEventType: string
  filterMaterialType: string
  filterEmployment: string
  filterLevel: string
  filterWorkplace: string
  clearFilters: string
  filtersAria: string
}

export interface PostMetaMessages {
  post: string
  kindJob: string
  kindInternship: string
  kindContract: string
  kindTestnet: string
  kindQuest: string
  kindCampaign: string
  kindAirdrop: string
  kindLearnEarn: string
  kindVolumeAlert: string
  kindAnalysis: string
  kindNews: string
  kindCareerGuide: string
  kindResearch: string
  kindArticle: string
  kindGraduateProgram: string
  kindHackathon: string
  kindCourse: string
  kindExplainer: string
  kindOpinion: string
  kindTutorial: string
  kindUpdate: string
  remote: string
  hybrid: string
  onsite: string
  global: string
  fullTime: string
  partTime: string
  intern: string
  junior: string
  mid: string
  senior: string
  lead: string
  director: string
  addedMinutesAgo: string
  addedHoursAgo: string
  addedDaysAgo: string
  addedOn: string
  draft: string
}

export interface PostListMessages {
  count: string
  loadMore: string
  end: string
  backToTop: string
  emptyTitle: string
  emptyText: string
}

export interface SupportMessages {
  title: string
  text: string
  textOptional: string
  cta: string
  price: string
}

export interface SaveMessages {
  signInTitle: string
  signInDesc: string
  signInAction: string
  savedToast: string
  savedPlain: string
  removed: string
  failed: string
  removeAria: string
  saveAria: string
}

export interface ArticleMessages {
  apply: string
  originalPost: string
  by: string
  badgeEditorial: string
  badgeBlog: string
  aboutMaterial: string
  publishedInVerify: string
  moreIn: string
}

export interface AboutMessages {
  metaTitle: string
  metaDescription: string
  title: string
  intro: string
  statsPending: string
  translationVia: string
  translationViaModel: string
  teamTitle: string
  teamSub: string
  roleCeo: string
  roleProgrammer: string
  bioPlaceholder: string
  openProfile: string
  pillarsTitle: string
  pillarsSub: string
  pillar1Title: string
  pillar1Text: string
  pillar2Title: string
  pillar2Text: string
  pillar3Title: string
  pillar3Text: string
  pillar4Title: string
  pillar4Text: string
  todayTitle: string
  todaySub: string
  readersTitle: string
  readers1: string
  readers2: string
  readers3: string
  readers4: string
  authorsTitle: string
  authors1: string
  authors2: string
  authors3: string
  authors4: string
  recapsTitle: string
  recapsSub: string
  recapTitle: string
  recapText: string
  pitchTitle: string
  pitchSub: string
  pitchCardTitle: string
  pitchNote: string
  openDeck: string
  requestDeck: string
  safetyText: string
  statsTitle: string
  statsSub: string
  visitors24h: string
  visitors7d: string
  visitors30d: string
  visitors365d: string
  vsDay: string
  vsWeek: string
  vsMonth: string
  vsYear: string
  newChip: string
  viewsTitle: string
  viewsSub: string
  viewsEmpty: string
  countriesTitle: string
  countriesSub: string
  countriesEmpty: string
  unknownCountry: string
  newPostsTitle: string
  newPostsEmpty: string
  premiumTitle: string
  premiumActive: string
  premiumPlusActive: string
  planBilling: string
  campaignsRunning: string
  adsWaitlistNote: string
  advertisersWaitlist: string
  siteTotals: string
  methodology: string
  bucket_home: string
  bucket_about: string
  bucketSearch: string
  bucketPremium: string
  bucketRecruiter: string
  bucketAds: string
  bucketAuth: string
  bucketProfile: string
  bucketAlerts: string
  bucketContact: string
  bucketOther: string
}

/** New top-level namespaces appended to every dictionary. */
export interface NewUiMessages {
  hero: HeroMessages
  quickLinks: QuickLinksMessages
  sections: SectionsMessages
  postMeta: PostMetaMessages
  postList: PostListMessages
  support: SupportMessages
  save: SaveMessages
  article: ArticleMessages
  about: AboutMessages
}

/** Keys added to EXISTING namespaces (injected inside their blocks). */
export interface ExistingNamespaceAdditions {
  common: { breadcrumb: string }
  search: { title: string; pageSub: string }
}

/** Full payload per locale: new namespaces + additions to existing ones. */
export interface LocalePayload {
  newNamespaces: NewUiMessages
  existing: ExistingNamespaceAdditions
}

export const LOCALE_ORDER = [
  'en', 'ru', 'uk', 'hi', 'zh', 'fa', 'ar', 'bn',
  'es', 'pt', 'fr', 'de', 'ko', 'ja', 'id',
  'fil', 'th', 'vi', 'tr', 'ur',
] as const

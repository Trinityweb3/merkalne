import { z } from 'zod'
import { POST_SECTIONS, REACTION_VALUES, REPORT_REASONS } from '@/lib/constants'

/**
 * Central Zod schemas — every API boundary validates with these before any
 * database access happens. Bodies are additionally size-capped to blunt
 * denial-of-service attempts via huge payloads.
 */

// --- primitives -------------------------------------------------------------

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'Email is too short')
  .max(254, 'Email is too long')
  .email('Enter a valid email address')

/** OWASP-aligned password policy. */
export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(128, 'Password must be at most 128 characters')
  .refine((v) => /[a-zA-Z]/.test(v) && /[0-9]/.test(v), 'Password must contain letters and numbers')

export const nameSchema = z.string().trim().min(1).max(80)

const safeUrl = z
  .string()
  .trim()
  .max(2048)
  .refine((v) => {
    try {
      const url = new URL(v)
      return url.protocol === 'http:' || url.protocol === 'https:'
    } catch {
      return false
    }
  }, 'Must be a valid http(s) URL')

// --- auth -------------------------------------------------------------------

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  name: nameSchema.optional(),
  acceptTerms: z.literal(true, { message: 'You must accept the Terms' }),
  /** Referral code of the inviter (?ref=CODE) — optional, validated at lookup */
  referralCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{4,16}$/).optional(),
})

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password is required').max(128),
})

export const magicLinkRequestSchema = z.object({ email: emailSchema })

export const magicLinkVerifySchema = z.object({
  token: z.string().min(20).max(200),
})

export const forgotPasswordSchema = z.object({ email: emailSchema })

export const resetPasswordSchema = z.object({
  token: z.string().min(20).max(200),
  password: passwordSchema,
})

export const verifyEmailSchema = z.object({ token: z.string().min(20).max(200) })

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: passwordSchema,
})

export const changeEmailSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newEmail: emailSchema,
})

// --- account ----------------------------------------------------------------

export const updateProfileSchema = z.object({
  name: nameSchema.optional(),
  bio: z.string().trim().max(600).optional(),
  links: z
    .array(safeUrl)
    .max(6, 'At most 6 links')
    .optional(),
})

// --- posts ------------------------------------------------------------------

const sectionEnum = z.enum(POST_SECTIONS)

export const createPostSchema = z.object({
  section: sectionEnum,
  title: z.string().trim().min(4, 'Title is too short').max(160, 'Title is too long'),
  kind: z.string().trim().max(40).optional().nullable(),
  company: z.string().trim().max(120).optional().nullable(),
  location: z.string().trim().max(120).optional().nullable(),
  workplace: z.string().trim().max(40).optional().nullable(),
  employment: z.string().trim().max(40).optional().nullable(),
  level: z.string().trim().max(40).optional().nullable(),
  salary: z.string().trim().max(80).optional().nullable(),
  stack: z.string().trim().max(160).optional().nullable(),
  body: z.string().trim().min(1, 'Post body is required').max(50_000, 'Post body is too long'),
  applyUrl: safeUrl.optional().nullable(),
  originalUrl: safeUrl.optional().nullable(),
  tags: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
  status: z.enum(['draft', 'published']).default('draft'),
})

export const updatePostSchema = createPostSchema.partial().extend({
  status: z.enum(['draft', 'published', 'archived']).optional(),
})

export const reactionSchema = z.object({
  value: z.enum([...REACTION_VALUES, 'none']),
})

export const commentSchema = z.object({
  body: z.string().trim().min(1, 'Comment cannot be empty').max(4000, 'Comment is too long'),
})

export const reportSchema = z.object({
  reason: z.enum(REPORT_REASONS),
  details: z.string().trim().max(2000).optional().or(z.literal('')),
  contact: z.union([emailSchema, z.literal('')]).optional(),
})

// --- misc -------------------------------------------------------------------

export const waitlistSchema = z.object({
  email: emailSchema,
  source: z.enum(['ads', 'premium', 'recruiter']).default('ads'),
})

export const contactSchema = z.object({
  email: emailSchema,
  subject: z.string().trim().min(3).max(160),
  body: z.string().trim().min(10, 'Message is too short').max(5000),
})

export const localeSchema = z.object({
  locale: z
    .string()
    .trim()
    .regex(/^[a-z]{2,3}$/, 'Invalid locale code')
    .max(3),
})

// --- search / listing query params -------------------------------------------

export const postListQuerySchema = z.object({
  section: sectionEnum.optional(),
  kind: z.string().trim().max(40).optional(),
  workplace: z.string().trim().max(40).optional(),
  employment: z.string().trim().max(40).optional(),
  level: z.string().trim().max(40).optional(),
  tag: z.string().trim().max(40).optional(),
  q: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  pageSize: z.coerce.number().int().min(1).max(24).default(10),
  sort: z.enum(['newest', 'oldest']).default('newest'),
  authorId: z.string().trim().max(40).optional(),
  status: z.enum(['draft', 'published', 'archived', 'deleted', 'all']).optional(),
})

export type PostListQuery = z.infer<typeof postListQuerySchema>

export const searchQuerySchema = z.object({
  q: z.string().trim().max(200).default(''),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  section: sectionEnum.optional(),
})

/** Parse a JSON request body safely (size + shape guarded). */
export async function parseJsonBody<T extends z.ZodTypeAny>(
  req: Request,
  schema: T,
): Promise<{ ok: true; data: z.infer<T> } | { ok: false; message: string; issues?: z.ZodIssue[] }> {
  const contentLength = Number(req.headers.get('content-length') ?? 0)
  if (contentLength > 128 * 1024) {
    return { ok: false, message: 'Request body too large' }
  }
  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return { ok: false, message: 'Invalid JSON body' }
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? 'Validation failed',
      issues: parsed.error.issues,
    }
  }
  return { ok: true, data: parsed.data }
}

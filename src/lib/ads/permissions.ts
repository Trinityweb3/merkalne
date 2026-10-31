/**
 * Merklane Ads Phase 4 — granular admin/advertiser permission tiers.
 *
 * User.adminRole (default "owner" — the migration backfills every existing
 * account, so these gates change NOBODY's behaviour until a role is
 * deliberately demoted by an owner admin):
 *
 *   owner    everything: campaign management, budgets, experiments,
 *            reports, balance administration, role management
 *   editor   campaign management (create/edit/budget/experiments) + reports
 *   analyst  reports only — read-only delivery statistics
 *   billing  balance administration (manual deposit confirmation /
 *            balance adjustments) only
 *
 * The task spec pins exactly two gates; they live here so every route shares
 * one definition:
 *   • campaign creation / budget changes → OWNER + EDITOR
 *   • viewing reports                    → OWNER + EDITOR + ANALYST
 * and the natural third for the money path:
 *   • balance adjustments                → OWNER + BILLING
 *
 * The functions take the SESSION user (never client input) — the role is
 * read from the database row via the session, it can never be spoofed.
 */

/** The closed set of permission tiers (User.adminRole values). */
export const ADMIN_ROLES = ['owner', 'editor', 'analyst', 'billing'] as const
export type AdminRole = (typeof ADMIN_ROLES)[number]

export function isAdminRole(value: string | null | undefined): value is AdminRole {
  return (ADMIN_ROLES as readonly string[]).includes(value ?? '')
}

/** Roles allowed to create campaigns and change budgets / experiments. */
const CAMPAIGN_MANAGER_ROLES: readonly AdminRole[] = ['owner', 'editor']
/** Roles allowed to view the delivery reports (Reports tab + CSV export). */
const REPORT_VIEWER_ROLES: readonly AdminRole[] = ['owner', 'editor', 'analyst']
/** Roles allowed to confirm manual deposits / adjust balances. */
const BALANCE_ROLES: readonly AdminRole[] = ['owner', 'billing']

/** The tier a session user actually holds ("owner" for unknown/legacy values). */
export function adminRoleOf(user: { adminRole?: string | null }): AdminRole {
  return isAdminRole(user?.adminRole) ? user.adminRole : 'owner'
}

/** OWNER + EDITOR — campaign creation, budget changes, A/B experiments. */
export function canManageCampaigns(user: { adminRole?: string | null }): boolean {
  return CAMPAIGN_MANAGER_ROLES.includes(adminRoleOf(user))
}

/** OWNER + EDITOR + ANALYST — viewing the reports (API + CSV export). */
export function canViewReports(user: { adminRole?: string | null }): boolean {
  return REPORT_VIEWER_ROLES.includes(adminRoleOf(user))
}

/** OWNER + BILLING — confirming manual deposits / adjusting balances. */
export function canAdjustBalance(user: { adminRole?: string | null }): boolean {
  return BALANCE_ROLES.includes(adminRoleOf(user))
}

/** OWNER only — reading the audit log, changing permission roles. */
export function isOwner(user: { adminRole?: string | null }): boolean {
  return adminRoleOf(user) === 'owner'
}

/** Human label for the UI / bot (English — the ads dashboard is not
 *  translated per-role yet; the badge chips stay short either way). */
export function adminRoleLabel(role: string | null | undefined): string {
  const tier = adminRoleOf({ adminRole: role })
  return tier === 'owner'
    ? 'Owner'
    : tier === 'editor'
      ? 'Editor'
      : tier === 'analyst'
        ? 'Analyst'
        : 'Billing'
}

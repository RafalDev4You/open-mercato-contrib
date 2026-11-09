/**
 * TC-CRM-7418: Company create form names the missing permission when address settings are forbidden
 *
 * The company create form loads the address format from `/api/customers/settings/address-format`,
 * which requires `customers.settings.manage`. A user who can manage companies but lacks that
 * feature gets a 403. Verifies:
 * - the address-format request returns 403 for that user
 * - the error flash names the missing permission instead of a bare "Forbidden"
 *
 * Fixtures: one role and one user created through the API and removed in `finally`.
 */
import { test, expect, type Page } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import {
  createRoleFixture,
  createUserFixture,
  deleteRoleIfExists,
  deleteUserIfExists,
  setRoleAclFeatures,
} from '@open-mercato/core/helpers/integration/authFixtures'
import { getTokenContext } from '@open-mercato/core/helpers/integration/generalFixtures'

export const integrationMeta = { dependsOnModules: ['customers'] }

const ADDRESS_FORMAT_PATH = '/api/customers/settings/address-format'
const MISSING_PERMISSION_MESSAGE =
  'Access denied: you are missing the required permission "customers.settings.manage". Contact your administrator.'
const LIMITED_FEATURES = [
  'customers.view',
  'customers.companies.view',
  'customers.companies.manage',
  'customers.people.view',
  'dictionaries.view',
]

function decodeJwtClaims(token: string): { tenantId?: string; orgId?: string | null } | null {
  const parts = token.split('.')
  if (parts.length < 2) return null
  try {
    const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as { tenantId?: string; orgId?: string | null }
  } catch {
    return null
  }
}

async function loginWithCredentials(page: Page, email: string, password: string): Promise<void> {
  const form = new URLSearchParams()
  form.set('email', email)
  form.set('password', password)
  const response = await page.request.post('/api/auth/login', {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    data: form.toString(),
  })
  expect(response.ok(), 'Limited user should be able to log in').toBeTruthy()
  const body = (await response.json().catch(() => null)) as { token?: string } | null
  const claims = typeof body?.token === 'string' ? decodeJwtClaims(body.token) : null
  const baseUrl = process.env.BASE_URL || 'http://localhost:3000'
  const cookies = []
  if (claims?.tenantId) {
    cookies.push({ name: 'om_selected_tenant', value: claims.tenantId, url: baseUrl, sameSite: 'Lax' as const })
  }
  if (claims?.orgId) {
    cookies.push({ name: 'om_selected_org', value: claims.orgId, url: baseUrl, sameSite: 'Lax' as const })
  }
  if (cookies.length > 0) await page.context().addCookies(cookies)
}

test.describe('TC-CRM-7418: address-format permission message on company create', () => {
  test('names the missing customers.settings.manage permission', async ({ page, request }) => {
    const stamp = Date.now()
    const email = `qa-tc-crm-7418-${stamp}@example.com`
    const password = 'Valid1!Pass'
    const roleName = `qa-tc-crm-7418-${stamp}`
    const adminToken = await getAuthToken(request, 'superadmin')
    let roleId: string | null = null
    let userId: string | null = null

    try {
      const { organizationId, tenantId } = getTokenContext(await getAuthToken(request, 'admin'))
      roleId = await createRoleFixture(request, adminToken, { name: roleName, tenantId })
      await setRoleAclFeatures(request, adminToken, { roleId, features: LIMITED_FEATURES, organizations: null })
      userId = await createUserFixture(request, adminToken, {
        email,
        password,
        organizationId,
        roles: [roleName],
        name: 'QA TC-CRM-7418 Limited',
      })

      await loginWithCredentials(page, email, password)
      const addressFormatResponse = page.waitForResponse(
        (response) => response.url().includes(ADDRESS_FORMAT_PATH) && response.request().method() === 'GET',
      )
      await page.goto('/backend/customers/companies/create', { waitUntil: 'domcontentloaded' })

      expect((await addressFormatResponse).status(), 'Address format should be forbidden for the limited user').toBe(403)
      await expect(page.getByText(MISSING_PERMISSION_MESSAGE).first()).toBeVisible()
      await expect(page.getByText('Forbidden', { exact: true })).toHaveCount(0)
    } finally {
      await deleteUserIfExists(request, adminToken, userId)
      await deleteRoleIfExists(request, adminToken, roleId)
    }
  })
})

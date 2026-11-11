/** Published schema + actual server canonicalizer; synthetic strings only. */
import { createHash } from 'node:crypto';
import { organizationSavedQueryDefinitionSchema } from '../../../../packages/shared/src/organization-collections-pins.ts';
import { canonicalOrganizationJson } from '../../../api/src/organization/authority.ts';
export function queryGoldenVectors() {
  const inputs = [
    { revision: 1, filters: {} },
    { revision: 1, filters: { mailbox: 'inbox', attention: 'all', text: '  retained  ' } },
    { revision: 1, filters: { dataSource: 'stored_mail', accountId: 'account', collectionId: 'a/b', sender: 'needle+nav@example.com', text: 'Équipe e\u0301 / "quoted" \\ line\n\t\u2028😀', classification: 'all', mailbox: 'all', attention: 'notify' } },
    { revision: 1, filters: { text: '\uFEFF\u00A0native\u3000', sender: ' Some Name ' } },
    { revision: 1, filters: { text: '\u0085not ECMAScript trim\u0085' } },
    { revision: 1, filters: { text: '😀'.repeat(100) } },
    { revision: 1, filters: { text: '\b\f\r\t/path' } },
    { revision: 1, filters: { text: 'same meaning' } },
    { revision: 1, filters: { text: 'same meaning', dataSource: 'stored_mail' } },
  ];
  const valid = inputs.map(input => {
    const normalized = organizationSavedQueryDefinitionSchema.parse(input), canonical = canonicalOrganizationJson(normalized);
    return { input, normalized, canonical, digest: createHash('sha256').update(canonical).digest('hex'), profile: normalized.filters.dataSource === 'stored_mail' ? 'stored-mail-v1' : 'legacy-pin-v1' };
  });
  const invalid = [
    { revision: 2, filters: {} }, { revision: 1, filters: { mailbox: 'all' } },
    { revision: 1, filters: { attention: 'all' } }, { revision: 1, filters: { invented: 'no' } },
    { revision: 1, filters: { text: ' \t\uFEFF' } }, { revision: 1, filters: { text: '😀'.repeat(101) } },
  ];
  if (!invalid.every(input => !organizationSavedQueryDefinitionSchema.safeParse(input).success)) throw Error('Golden negative precondition failed');
  return { valid, invalid };
}

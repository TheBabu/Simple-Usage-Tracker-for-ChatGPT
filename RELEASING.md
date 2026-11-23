# Releasing

1. Add an entry for the new version at the top of `release-notes/changelog.json`, written for
   users. After the update, the extension opens it in a Release Notes tab (behind the current one),
   above the notes for earlier versions. A version without an entry updates quietly, which suits a
   small fix. Entries for versions newer than the manifest stay hidden, so notes can be written
   ahead.

   ```json
   {
     "version": "0.3.0",
     "date": "2026-10-05",
     "title": "An optional headline",
     "changes": [
       "One short, plain sentence per change, in sentence case."
     ]
   },
   ```

   It's JSON, so double quotes inside a change need a backslash (`\"`), and the last item in a
   list takes no comma. `npm run build` fails if the file doesn't parse.
2. Bump `version` in `manifest.json` and push it to `main`.
3. The **Release** workflow sees the new version, tags the commit (`v0.2.0`), builds
   `simple-tracker-for-chatgpt-v0.2.0.zip` and publishes it as a GitHub release. Its notes are the
   version's entry from `release-notes/changelog.json` (`node scripts/release-notes.mjs` previews
   them), with the commits since the last release folded away below; a version without an entry
   lists just the commits. A push that changes `manifest.json` but not the version publishes
   nothing.
4. With Chrome Web Store publishing configured, **Release** uploads that same ZIP and submits it for
   review. Google publishes the update on approval. Until publishing is configured, upload the ZIP
   in the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole).

Each version is released once and never replaced, so ship a fix as a new version.

To build the zip locally, run `node scripts/build.mjs` (Node 18 or newer). It lands in `dist/`.

## Set up automatic Chrome Web Store updates

1. Enable the Chrome Web Store API, IAM, IAM Service Account Credentials and Security Token Service
   APIs in a Google Cloud project. Create a service account and add its email under **Account** in
   the Chrome Web Store Developer Dashboard. The dashboard also shows your publisher ID under
   **Publisher → Settings**. [Chrome Web Store service account setup](https://developer.chrome.com/docs/webstore/service-accounts)
2. Create a Workload Identity pool and an OIDC provider with issuer
   `https://token.actions.githubusercontent.com`. Under **Configure provider attributes**, add
   these mappings.

   | Google attribute | OIDC claim |
   |---|---|
   | `google.subject` | `assertion.sub` |
   | `attribute.repository_id` | `assertion.repository_id` |
   | `attribute.ref` | `assertion.ref` |

   Under **Attribute conditions** on the same screen, paste this expression to restrict access
   to this repository's `main` branch.

   ```text
   assertion.repository_id == '1403874179' && assertion.ref == 'refs/heads/main'
   ```

   Grant `roles/iam.workloadIdentityUser` on the service account to
   `principalSet://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/POOL_ID/attribute.repository_id/1403874179`.
   GitHub exchanges its OIDC identity for a short-lived access token with the Chrome Web Store
   scope. [Google Cloud federation setup](https://cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines)
3. Add these [GitHub Actions repository variables](https://github.com/TheBabu/Simple-Usage-Tracker-for-ChatGPT/settings/variables/actions).

   | Variable | Value |
   |---|---|
   | `CWS_PUBLISHER_ID` | The publisher ID from the Chrome Web Store Developer Dashboard |
   | `CWS_SERVICE_ACCOUNT` | The service account email registered in the dashboard |
   | `CWS_WORKLOAD_IDENTITY_PROVIDER` | `projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/POOL_ID/providers/PROVIDER_ID` |

Once all three variables are set, new GitHub releases go to the existing Store item
`jidllgipcneeonigpfaljejnmjodhkga`. For a release that was already created, run **Chrome Web Store**
from the repository's **Actions** tab on `main` and enter its tag. If the upload succeeded and
submission failed, check the draft version in the Developer Dashboard before retrying.
To check the current published and submitted versions, run the same workflow with
**Show published and submitted versions** checked and leave the tag blank. The run summary
shows the Store API response for each revision.

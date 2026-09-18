# Moodle browser AJAX API

This document records the authenticated, read-only Moodle API path verified against a Moodle site from the persistent `user` Chrome profile.

## Is it the official Moodle API?

It uses the same **External functions** layer as Moodle Web Services, but it is not the same client interface as the token-authenticated REST protocol.

Moodle's `core/ajax` module calls External functions through the browser. A function is available through this path only when its service declaration includes `ajax: true`. The REST endpoint exposes functions included in an enabled External service and authenticates them with a Web Service token. Therefore, a function name and its validated arguments or result can overlap between AJAX and REST, while availability, authentication, request framing, and lifecycle differ.

| Property | Browser AJAX | Official REST Web Service |
|---|---|---|
| Endpoint | `/lib/ajax/service.php` | `/webservice/rest/server.php` |
| Intended client | Moodle web interface | External applications |
| Authentication | Existing Moodle session cookie | Web Service token (`wstoken`) |
| Request proof | Session-bound `sesskey` | Token sent with the request |
| Function availability | Function declared with `ajax: true` | Function included in an enabled service |
| Request format | JSON array; multiple calls may be batched | Protocol parameters including one `wsfunction` |
| Lifetime | Ends with the browser session | Controlled by the issued token/service policy |
| Stability for integrations | Internal UI contract; can change with the site | Supported external-integration contract |

The `sesskey` is not a standalone bearer token. The Moodle session cookie authenticates the user; the `sesskey` is session-bound request protection. Copying only the `sesskey` to another process does not create an authenticated REST client.

## Verified endpoint

Base URL:

```text
https://moodle.example.edu
```

Verified browser endpoint:

```text
POST /lib/ajax/service.php
     ?sesskey=<CURRENT_SESSION_KEY>
     &info=core_course_get_enrolled_courses_by_timeline_classification
```

Verified function:

```text
core_course_get_enrolled_courses_by_timeline_classification
```

On 2026-07-17, the call succeeded inside the logged-in browser session and returned the enrolled courses. A request to the REST endpoint using only the browser session, without `wstoken`, returned `invalidtoken`. No credential values were recorded.

## Safe browser-context example

Run this only inside the already authenticated Moodle page, for example through Playwright attached to the persistent Chrome profile. It reads the current `sesskey` at runtime and does not write it to disk or print it.

```js
async function getEnrolledCourses() {
  const baseUrl = 'https://moodle.example.edu';
  const sesskey = globalThis.M?.cfg?.sesskey;

  if (!sesskey) {
    throw new Error('No active Moodle session key');
  }

  const methodname =
    'core_course_get_enrolled_courses_by_timeline_classification';
  const response = await fetch(
    `${baseUrl}/lib/ajax/service.php` +
      `?sesskey=${encodeURIComponent(sesskey)}` +
      `&info=${encodeURIComponent(methodname)}`,
    {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([
        {
          index: 0,
          methodname,
          args: {
            classification: 'all',
            limit: 0,
            offset: 0,
            sort: 'fullname',
            customfieldname: '',
            customfieldvalue: ''
          }
        }
      ])
    }
  );

  const [result] = await response.json();
  if (result.error) {
    throw new Error(result.exception?.message || 'Moodle AJAX call failed');
  }
  return result.data.courses;
}
```

## Operational rules

- Attach to the existing `user` Chrome profile; do not copy cookies or authentication headers into scripts.
- Read `M.cfg.sesskey` immediately before a call and keep it in memory only.
- Use read-only functions unless the user explicitly requests a mutation.
- Treat every returned object as private account data.
- Expect calls to fail after logout, session expiry, SSO renewal, or a Moodle upgrade.
- Do not assume that an AJAX-enabled function is included in a REST service, or vice versa.
- Prefer an administrator-issued Web Service token for a durable external integration.

## Official references

- [Moodle AJAX guide](https://moodledev.io/docs/5.3/guides/javascript/ajax)
- [Moodle External Services](https://moodledev.io/docs/5.3/apis/subsystems/external)
- [Moodle function declarations](https://moodledev.io/docs/5.3/apis/subsystems/external/description)

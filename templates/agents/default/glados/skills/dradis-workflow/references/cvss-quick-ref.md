# CVSS Quick Reference — Common Red Team Finding Types

Using CVSS v3.1. Always include the full vector string alongside the numeric score.

---

## Vector String Format

`CVSS:3.1/AV:<>/AC:<>/PR:<>/UI:<>/S:<>/C:<>/I:<>/A:<>`

| Metric | Options |
|--------|---------|
| AV (Attack Vector) | N=Network, A=Adjacent, L=Local, P=Physical |
| AC (Attack Complexity) | L=Low, H=High |
| PR (Privileges Required) | N=None, L=Low, H=High |
| UI (User Interaction) | N=None, R=Required |
| S (Scope) | U=Unchanged, C=Changed |
| C (Confidentiality) | N=None, L=Low, H=High |
| I (Integrity) | N=None, L=Low, H=High |
| A (Availability) | N=None, L=Low, H=High |

---

## Common Finding Templates

### IDOR / Broken Object Level Authorization
- **Typical Score:** 7.5–8.8 (High)
- **Vector:** `CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:N`
- **Notes:** Adjust PR to N if unauthenticated access. Adjust C/I based on data sensitivity.

### Authentication Bypass (Full)
- **Typical Score:** 9.8 (Critical)
- **Vector:** `CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H`
- **Notes:** Use if bypass grants full account access without credentials.

### Authentication Bypass (Partial / Limited Access)
- **Typical Score:** 7.3–8.1 (High)
- **Vector:** `CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:L/A:N`

### SQL Injection (Read-Only / Error-Based)
- **Typical Score:** 7.5 (High)
- **Vector:** `CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N`

### SQL Injection (Write / RCE potential)
- **Typical Score:** 9.8 (Critical)
- **Vector:** `CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H`

### Stored XSS
- **Typical Score:** 6.1–8.0 (Medium–High)
- **Vector:** `CVSS:3.1/AV:N/AC:L/PR:L/UI:R/S:C/C:L/I:L/A:N`
- **Notes:** Scope changes to C when it affects other users. Adjust PR based on auth requirement.

### Reflected XSS
- **Typical Score:** 6.1 (Medium)
- **Vector:** `CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N`

### SSRF (Internal Network Access)
- **Typical Score:** 8.6–9.0 (High–Critical)
- **Vector:** `CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:L/A:N`

### Business Logic Flaw (Data Manipulation)
- **Typical Score:** 6.5–7.5 (Medium–High)
- **Vector:** `CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:H/A:N`

### Improper Access Control (Privilege Escalation)
- **Typical Score:** 8.8 (High)
- **Vector:** `CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:N`

### Information Disclosure (Sensitive Data Exposure)
- **Typical Score:** 5.3–7.5 (Medium–High)
- **Vector:** `CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N`
- **Notes:** Adjust based on sensitivity: PII/credentials = High C, generic app data = Low/Medium C.

---

## Severity Bands

| Score | Severity |
|-------|----------|
| 9.0–10.0 | Critical |
| 7.0–8.9 | High |
| 4.0–6.9 | Medium |
| 0.1–3.9 | Low |
| 0.0 | Informational |

---

## Finding Priority (per REDTEAM_MASTER.md)

| Classification | Criteria |
|---------------|----------|
| **PRIORITY** | Shell, data exfil at scale, full auth bypass, internal access, material business impact |
| **INFORMATIONAL** | Real finding but no clear escalation path → goes to appendix only |

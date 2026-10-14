# Media transport test certificates

- Local test CA and server certificate for localhost / 127.0.0.1; valid from 2026-09-16 to 2036-09-13.
- The P-521 CA signs the RSA server certificate with SHA-512, exercising enterprise proxy certificate compatibility over both HTTPS and WSS. The same certificates are used by `http-test-support`.
- The private key is public test data, never a product credential.
- Used to verify that room-scoped TLS accepts its configured CA and rejects it under system trust.

BCSM COMPUTER EDUCATION CENTER — GitHub Pages Preview Package

FILES
- index.html: current BCSM website interface and existing demo/localStorage behavior
- firebase-config.js: Firebase web-app public configuration
- firebase-init.js: initializes Firebase SDK only; it does NOT migrate student/admin data or implement auth flows
- .nojekyll: tells GitHub Pages not to process files with Jekyll

IMPORTANT BEFORE PUBLICATION
This package can be uploaded to GitHub Pages as a preview, but it is NOT production-ready for real student accounts or payments. The current app still uses localStorage for much of its data/auth logic. Do not use real student personal data or passwords. Gmail 6-digit OTP, secure forgot-password flow, server-verified Cashfree orders/webhooks, and server-side course access control are NOT implemented by this package. The Cashfree mention in the UI is not proof of live payment integration.

Firebase security
Keep Firestore rules deny-by-default until real Firebase Auth + rules are implemented and tested. Never put Gmail passwords, Google App Passwords, Cashfree secret keys, service account keys, or email-provider API secrets in index.html or any GitHub file. Web Firebase config is public by design; Firestore rules and Authentication must enforce access.

GITHUB PAGES
1. Extract this ZIP on your computer.
2. Open your new GitHub repository.
3. Upload the CONTENTS of this folder (not the containing folder): index.html, firebase-config.js, firebase-init.js, .nojekyll, README_HINDI_GITHUB.txt.
4. In repository Settings > Pages, select Deploy from a branch, branch main, folder /(root), and Save.
5. Wait for the Pages URL shown by GitHub. Add the final URL to Google Search Console after the site is live.

SEO
The page already contains a title, description, and EducationalOrganization structured data. The exact canonical URL, robots.txt, and sitemap.xml should be created after the final GitHub Pages URL is known. Search indexing is not guaranteed or instant.

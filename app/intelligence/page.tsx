// import dynamic from 'next/dynamic';
// import React from 'react';

// const FeedClient = dynamic(() => import('./FeedClient'), { ssr: false });

// export default function IntelligencePage() {
//   return (
//     <main style={{ margin: 0, padding: 0, maxWidth: '100%', minHeight: '100vh' }}>
//       <style>{`
//         * { box-sizing: border-box; }
//         body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
//         @media (max-width: 640px) {
//           main { max-width: 100%; }
//         }
//         @media (min-width: 641px) {
//           main { max-width: 600px; margin: 0 auto; }
//         }
//       `}</style>
//       <FeedClient />
//     </main>
//   );
// }
'use client';

import dynamic from 'next/dynamic';
import React from 'react';

const FeedClient = dynamic(() => import('./FeedClient'), {
  ssr: false,
});

export default function IntelligencePage() {
  return (
    <main style={{ margin: 0, padding: 0, maxWidth: '100%', minHeight: '100vh' }}>
      <style>{`
        * { box-sizing: border-box; }
        body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
        @media (max-width: 640px) {
          main { max-width: 100%; }
        }
        @media (min-width: 641px) {
          main { max-width: 600px; margin: 0 auto; }
        }
      `}</style>

      <FeedClient />
    </main>
  );
}
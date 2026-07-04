import { createApp } from './app.js';

const port = Number(process.env.PORT || 4100);
createApp().listen(port, () => {
  console.log(`Flowboard API: http://localhost:${port}`);
});


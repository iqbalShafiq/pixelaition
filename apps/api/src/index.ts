import { createApp } from "./app.js";

const port = Number(process.env.API_PORT ?? 3001);
createApp().listen(port, "0.0.0.0", () => {
  console.log(`api listening on ${port}`);
});

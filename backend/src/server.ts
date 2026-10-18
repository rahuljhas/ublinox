import { createContext } from "./context.js";
import { createApp } from "./http/app.js";

const ctx = createContext();
const port = Number(process.env.PORT ?? 3000);

createApp(ctx).listen(port, () => {
  console.log(
    `checkout-api listening on http://localhost:${port} ` +
      `(coupon every ${ctx.config.couponEveryNOrders} orders, ${ctx.config.couponPercentOff}% off)`,
  );
});

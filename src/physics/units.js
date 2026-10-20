// 単位換算と物理定数。内部計算はすべて SI 単位系で行う。

export const LBF = 4.4482216;      // 1 lbf [N]
export const INCH = 0.0254;        // 1 inch [m]
export const GRAIN = 6.479891e-5;  // 1 grain [kg]
export const OZ = 0.028349523;     // 1 oz [kg]
export const G = 9.80665;          // 重力加速度 [m/s^2]
export const RHO_AIR = 1.225;      // 空気密度 (15℃, 海面) [kg/m^3]
export const MRAD = 1e-3;

export const deg = (d) => (d * Math.PI) / 180;
export const toDeg = (r) => (r * 180) / Math.PI;
export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

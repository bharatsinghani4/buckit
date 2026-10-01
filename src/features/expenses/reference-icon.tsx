import {
  Banknote,
  BriefcaseBusiness,
  CarFront,
  CircleHelp,
  Clapperboard,
  Coffee,
  CreditCard,
  Fuel,
  HeartPulse,
  House,
  Landmark,
  Plane,
  ShoppingBag,
  ShoppingBasket,
  Smartphone,
  Store,
  Tag,
  Utensils,
  Wallet,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { OptionKind } from "./contracts";

const categoryIcons: [RegExp, LucideIcon][] = [
  [/grocer|pantry|food shop|supermarket/i, ShoppingBasket],
  [/utilit|electric|power|water|gas|bill/i, Zap],
  [/home|hous|rent|apartment|furnitur/i, House],
  [/dining|restaurant|meal|food|eat/i, Utensils],
  [/transport|taxi|cab|commut|car|bus|train/i, CarFront],
  [/health|medic|pharmac|doctor/i, HeartPulse],
  [/shopping|cloth|fashion/i, ShoppingBag],
  [/entertain|movie|stream|cinema/i, Clapperboard],
  [/travel|flight|hotel|trip/i, Plane],
  [/coffee|cafe/i, Coffee],
  [/fuel|petrol/i, Fuel],
  [/phone|internet|software|subscription/i, Smartphone],
  [/work|office|business/i, BriefcaseBusiness],
];

export function referenceIcon(kind: OptionKind, name: string, iconKey?: string): LucideIcon {
  const label = `${iconKey ?? ""} ${name}`;
  if (kind === "categories") {
    return categoryIcons.find(([pattern]) => pattern.test(label))?.[1] ?? Tag;
  }
  if (kind === "platforms") return Store;
  if (/cash/i.test(label)) return Banknote;
  if (/credit|debit|card/i.test(label)) return CreditCard;
  if (/bank|account|hdfc|icici|sbi/i.test(label)) return Landmark;
  return kind === "accounts" ? Wallet : CircleHelp;
}

export function ReferenceGlyph({
  kind,
  name,
  iconKey,
  size = 18,
}: {
  kind: OptionKind;
  name: string;
  iconKey?: string;
  size?: number;
}) {
  const Icon = referenceIcon(kind, name, iconKey);
  return <Icon size={size} aria-hidden="true" />;
}

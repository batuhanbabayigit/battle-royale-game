// Cosmetic skins purchasable with in-game coins.
const SKINS = [
  { id: 'default', name: 'Varsayilan', color: '#3ba9ff', price: 0 },
  { id: 'crimson', name: 'Kizil Savasci', color: '#e35b5b', price: 150 },
  { id: 'emerald', name: 'Zumrut Avci', color: '#3ee88a', price: 150 },
  { id: 'violet', name: 'Mor Gece', color: '#9b6bff', price: 220 },
  { id: 'gold', name: 'Altin Sampiyon', color: '#ffd23f', price: 400 },
  { id: 'obsidian', name: 'Obsidyen Golge', color: '#3a3a46', price: 400 },
  { id: 'ice', name: 'Buz Kristali', color: '#8fe8ff', price: 300 },
];

// Real-money coin packages. Placeholder until a payment provider (Stripe/iyzico) is
// connected by the site owner via their own account + API keys in Railway variables.
const COIN_PACKAGES = [
  { id: 'pack_100', coins: 100, priceLabel: '19,99 TL' },
  { id: 'pack_300', coins: 300, priceLabel: '49,99 TL' },
  { id: 'pack_1000', coins: 1000, priceLabel: '129,99 TL' },
];

function findSkin(id) {
  return SKINS.find((s) => s.id === id) || null;
}

module.exports = { SKINS, COIN_PACKAGES, findSkin };

/**
 * The demo shop's customers.
 *
 * Invented people at `example.test` addresses. The `.test` top-level domain is reserved and
 * never resolves, so nothing the shop sends one of them can reach a real inbox — which
 * matters, because a seeded order's receipt is owed to its customer exactly like a real one.
 *
 * `often` is how regularly each shops, relative to the others: a small shop has a few people
 * who come in every week and many who came once.
 */

export type SeedPerson = {
  name: string;
  email: string;
  often: number;
  address: { line1: string; city: string; region?: string; postalCode?: string; country: string };
};

const person = (
  name: string,
  often: number,
  line1: string,
  city: string,
  country: string,
  postalCode?: string,
  region?: string,
): SeedPerson => ({
  name,
  email: `${name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z]+/g, '.')}@example.test`,
  often,
  address: {
    line1,
    city,
    country,
    ...(postalCode ? { postalCode } : {}),
    ...(region ? { region } : {}),
  },
});

export const PEOPLE: SeedPerson[] = [
  person('Ada Lindqvist', 6, '14 Mill Lane', 'York', 'GB', 'YO1 7HT'),
  person('Tomás Ferreira', 3, 'Rua das Flores 22', 'Porto', 'PT', '4050-262'),
  person('Imogen Hale', 5, '3 Orchard Row', 'Bristol', 'GB', 'BS8 1QU'),
  person('Kwame Mensah', 4, '48 Carlisle Road', 'Leeds', 'GB', 'LS6 2AL'),
  person('Noor Haddad', 2, '9 Rue Chapon', 'Paris', 'FR', '75003'),
  person('Felix Brandt', 3, 'Lindenstraße 17', 'Berlin', 'DE', '10969'),
  person('Harriet Okafor', 5, '27 Canal Walk', 'Manchester', 'GB', 'M4 6BF'),
  person('Mateo Rossi', 2, 'Via Garibaldi 5', 'Turin', 'IT', '10122'),
  person('Priya Raman', 4, '112 Grove Street', 'Brooklyn', 'US', '11221', 'NY'),
  person('Owen Gallagher', 3, '6 Harbour View', 'Cork', 'IE', 'T12 X2E7'),
  person('Sofia Almeida', 2, 'Avenida da Liberdade 180', 'Lisbon', 'PT', '1250-146'),
  person('Jonah Whitfield', 3, '31 Hill Street', 'Edinburgh', 'GB', 'EH2 3JP'),
  person('Mei Tanaka', 4, '2-14 Nakameguro', 'Tokyo', 'JP', '153-0061'),
  person('Samuel Adeyemi', 2, '19 Admiralty Way', 'Lagos', 'NG', '101233'),
  person('Clara Dubois', 3, '8 Quai Saint-Vincent', 'Lyon', 'FR', '69001'),
  person('Rufus Ellery', 1, 'The Old Forge', 'Hay-on-Wye', 'GB', 'HR3 5AE'),
  person('Lena Novak', 2, 'Keizersgracht 403', 'Amsterdam', 'NL', '1016 EK'),
  person('Isaac Morgan', 3, '75 Wellington Street', 'Toronto', 'CA', 'M5J 1H1', 'ON'),
  person('Beatrix Cole', 4, '4 Laurel Terrace', 'Bath', 'GB', 'BA1 2LL'),
  person('Aarav Shah', 2, '221 Linking Road', 'Mumbai', 'IN', '400050'),
  person('Ingrid Solberg', 2, 'Grünerløkka 12', 'Oslo', 'NO', '0552'),
  person('Theo Marchetti', 1, 'Via Tornabuoni 9', 'Florence', 'IT', '50123'),
  person('Grace Whelan', 3, '58 Dame Street', 'Dublin', 'IE', 'D02 KH36'),
  person('Daniel Kim', 2, '903 Pine Street', 'Seattle', 'US', '98101', 'WA'),
  person('Esme Llewellyn', 5, '12 Castle Street', 'Cardiff', 'GB', 'CF10 1BS'),
  person('Luca Moreau', 1, '41 Rue Oberkampf', 'Paris', 'FR', '75011'),
  person('Amara Nwosu', 3, '17 Victoria Street', 'Glasgow', 'GB', 'G1 1TH'),
  person('Henrik Dahl', 1, 'Vesterbrogade 56', 'Copenhagen', 'DK', '1620'),
  person('Charlotte Reyes', 2, '350 Hayes Street', 'San Francisco', 'US', '94102', 'CA'),
  person('Yusuf Karim', 2, '22 Kings Road', 'Brighton', 'GB', 'BN1 2NA'),
  person('Olivia Brennan', 4, '9 Wattle Street', 'Melbourne', 'AU', '3000', 'VIC'),
  person('Nikhil Varma', 1, '88 Residency Road', 'Bengaluru', 'IN', '560025'),
  person('Rosalind Ashby', 3, '2 Church Walk', 'Oxford', 'GB', 'OX2 6JE'),
  person('Kenji Mori', 2, '5-3 Gion', 'Kyoto', 'JP', '605-0074'),
  person('Zara Ibrahim', 2, '64 Deansgate', 'Manchester', 'GB', 'M3 2EP'),
  person('Anselm Weber', 1, 'Schillerstraße 3', 'Munich', 'DE', '80336'),
];

'use strict';
// Écrit deux lignes sur stdout, une sur stderr ; avec --wait, reste en vie jusqu'à ce qu'on le tue.
console.log('un');
console.error('deux');
console.log('trois');
if (process.argv.includes('--wait')) setInterval(() => {}, 1000);

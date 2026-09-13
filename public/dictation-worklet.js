/* Le collecteur d'échantillons de la dictée, côté audio.
 *
 * Un AudioWorklet, et pas un ScriptProcessorNode : celui-ci est déprécié et tourne sur le fil
 * principal, où le moindre rendu de carte (elles se redessinent toutes les 1,5 s) produit un
 * trou dans l'enregistrement. Ici le fil audio n'est jamais interrompu par l'interface.
 *
 * On ne fait RIEN de savant ici : on empile les échantillons et on les poste par paquets de
 * 32 ms. La détection de parole, le découpage et la fabrication du WAV vivent sur le fil
 * principal, où ils sont lisibles et testables — un worklet est un endroit coûteux à déboguer.
 *
 * Le contexte audio est créé à 16 kHz : c'est lui qui rééchantillonne, pas nous. */
const TRAME = 512;   // 32 ms à 16 kHz — la fenêtre du RMS glissant, côté fil principal

class CollecteurDictee extends AudioWorkletProcessor {
  constructor() {
    super();
    this.tampon = new Float32Array(TRAME);
    this.n = 0;
  }

  process(entrees) {
    const canal = entrees[0] && entrees[0][0];
    if (!canal) return true;                 // micro coupé : on reste vivant, sans rien poster
    for (let i = 0; i < canal.length; i += 1) {
      this.tampon[this.n] = canal[i];
      this.n += 1;
      if (this.n === TRAME) {
        // Une COPIE : le tampon est réutilisé au tour suivant, et le transfert le viderait.
        this.port.postMessage(this.tampon.slice(0));
        this.n = 0;
      }
    }
    return true;
  }
}

registerProcessor('collecteur-dictee', CollecteurDictee);

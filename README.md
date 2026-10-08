# MeshLab RF

## Le laboratoire radio LoRa dans votre navigateur

**MeshLab RF est le nouveau simulateur haute performance pour concevoir, tester et expliquer un réseau Meshtastic ou MeshCore avant de déplacer le moindre équipement.**

> **Placez vos nœuds. Lancez la simulation. Prenez une décision.**

**NOUVEAU** · **RAPIDE** · **LOCAL** · **SANS COMPTE** · **MESHTASTIC + MESHCORE**

[**Télécharger MeshLab RF**](https://github.com/1234LUCIUS/meshlab-rf/releases/latest/download/meshlab-rf.zip) · [Voir la release](https://github.com/1234LUCIUS/meshlab-rf/releases/latest)

---

## Pourquoi l’utiliser ?

Un réseau radio ne se juge pas seulement sur une carte théorique. **Le relief, les distances, les antennes, le bâti, la végétation, les collisions et le protocole changent le résultat.**

MeshLab RF vous permet de comparer rapidement plusieurs implantations et de comprendre ce qui se passe réellement :

- **où la liaison passe ;**
- **où elle devient limite ;**
- **quel nœud relaie ;**
- **pourquoi un paquet est perdu ;**
- **comment le protocole se comporte quand le réseau grandit.**

## Ce que vous obtenez

| Besoin | Réponse MeshLab RF |
|---|---|
| Préparer une installation | Testez les emplacements et les hauteurs d’antenne sur une carte réelle. |
| Choisir un protocole | Comparez Meshtastic et MeshCore dans le même environnement. |
| Trouver les points faibles | Visualisez les liaisons bonnes, limites ou impossibles. |
| Expliquer une décision | Montrez le bilan détaillé d’une liaison, d’un paquet ou d’un relais. |
| Tester la montée en charge | Générez des scénarios, du trafic, des collisions et des pertes. |
| Gagner du temps | Lancez l’outil localement, sans compte et sans installation npm. |

## Les points forts

### Une simulation qui ne se contente pas de dessiner des points

- **Relief réel** avec source IGN en France et repli SRTM mondial.
- **Végétation et bâti** pris en compte dans le bilan de liaison.
- **Paramètres radio** : fréquence, puissance, gain d’antenne, SF, bande passante et coding rate.
- **Comportements protocolaires** : relais, flood, ACK, retransmissions, adverts, hop limit et duty cycle.
- **Moteur à événements discrets** pour suivre les émissions, relais, collisions et livraisons.
- **Calculs ciblés autour des nœuds** et cache géographique pour éviter les téléchargements inutiles.
- **Dashboard, journal et inspecteurs** pour passer de la vue globale au diagnostic précis.

## Pour qui ?

### Pour les débutants

Pas besoin d’être spécialiste radio pour commencer :

1. choisissez **Meshtastic** ou **MeshCore** ;
2. ajoutez quelques nœuds sur la carte ;
3. lancez une simulation ;
4. lisez les liaisons vertes, orange et rouges.

### Pour les professionnels

Allez plus loin avec les réglages fins, les scénarios, le trafic, le terrain réel, les profils réglementaires, les bilans de liaison et l’analyse détaillée des paquets.

## Télécharger et démarrer — sans localhost

1. **[Téléchargez la dernière version (.zip)](https://github.com/1234LUCIUS/meshlab-rf/releases/latest/download/meshlab-rf.zip)**.
2. Décompressez l’archive.
3. Ouvrez simplement **`index.html`** dans votre navigateur.

> **C’est tout :** pas besoin de lancer un serveur, pas besoin d’ouvrir `localhost`, pas besoin d’installer npm. Le mode direct utilise les services cartographiques publics depuis votre navigateur.

Pour un usage avancé ou un réseau avec relais Overpass local, `start.bat` et `start.sh` restent disponibles en option.

## Une décision plus rapide, avant le terrain

MeshLab RF ne remplace pas une mesure terrain : il vous aide à **arriver sur le terrain avec une implantation déjà réfléchie**, à comparer vos hypothèses et à identifier les zones qui méritent une mesure réelle.

[**Lancer le téléchargement**](https://github.com/1234LUCIUS/meshlab-rf/releases/latest/download/meshlab-rf.zip)

## Ressources

- [Dernière version](https://github.com/1234LUCIUS/meshlab-rf/releases/latest)
- [Documentation technique](docs/technique.md)
- [Historique des versions](https://github.com/1234LUCIUS/meshlab-rf/releases)

## Licence

Projet privé — réservé aux utilisateurs autorisés du dépôt.

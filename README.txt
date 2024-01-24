# enigma2 Support for Homey

This Project allows Control of Enigma2 devices via Homey over TCP/IP

## Requirements

1) openWebif needs to be available on the enigma2 device
2) Setup of enigma2 App via Homey required.
   (More section, select Apps Menu, open enigma2 entry and Click on “App settings”)

## Support Overview

### when / trigger flowcards

- [ ] polling required, therefore currently not yet implemented

### and / condition flowcards

- [x] Standby ON/OFF

### then / action flowcards

- [x] [deep standby mode](#deep-standby-mode)
- [x] reboot enigma2 software
- [x] reboot receiver
- [x] send command as ID (see below for Info)
- [x] [send message](#messages)
- [x] standby mode
- [x] standby wake
- [x] Volume mute
- [x] Volume set (0% - 100%)
- [x] Volume unmute

### Supported Languages

- [x] 🇳🇱 dutch - Thanks to Martin Timmermans
- [x] 🇬🇧 english
- [x] 🇩🇪 german

## deep standby mode

**WARNING:**
After this flowcard is executed you can't control the box over the Network Interface anymore!

## Messages

During the Input you need to make sure you follow these Format:
    Type|Timeout|Message
inbetween the different Sections no Spaces are required.
Here are the different Supported Variables:
Type:

- 0 = Yes / No (currently only Display, no action yet implemented)
- 1 = Info Message
- 2 = Plain Message
- 3 = Attention Message

Timeout:

- set it to 0 to be endless displayed or Provide Time in seconds

Message:

- Type your Text here, to make a new line use \n in the Text without a Space afterwards.



import 'jasmine';
import { MissionData, MissionOfferLocation } from 'novadatainterface/MissionData';
import { MissionOfferPrompt } from './mission_offer_dialog';

describe('MissionOfferDialog configuration', () => {
    const mockMission: MissionData = {
        id: 'nova:150',
        prefix: 'nova',
        name: 'Classified Delivery',
        availLoc: MissionOfferLocation.MainSpaceport,
        availStel: 128,
        availRecord: 0,
        availRating: 0,
        availRandom: 100,
        travelStel: 130,
        returnStel: -1,
        destination: 130,
        returnDestination: -1,
        cargoType: -1,
        cargoQty: 0,
        cargo: null,
        pickupMode: 0,
        dropOffMode: 0,
        scanMask: 0,
        payVal: 25000,
        pay: 25000,
        shipCount: 0,
        shipSyst: -1,
        shipDude: -1,
        shipGoal: -1,
        shipBehav: 0,
        shipNameID: -1,
        shipStart: 0,
        compGovt: -1,
        compReward: 0,
        shipSubtitle: -1,
        briefTextID: 150,
        quickBriefID: -1,
        loadCargTextID: -1,
        dumpCargoTextID: -1,
        compTextID: -1,
        failTextID: -1,
        shipDoneTextID: -1,
        refuseTextID: -1,
        offerText: 'An operative hands you a sealed data chip.',
        briefText: 'Deliver this to Tau Ceti.',
        quickBrief: '',
        loadCargText: '',
        dumpCargoText: '',
        compText: 'Delivery confirmed.',
        failText: 'You lost the data.',
        shipDoneText: '',
        refuseText: 'Very well, we will find someone else.',
        timeLimit: 14,
        canAbort: true,
        auxShipCount: 0,
        auxShipDude: -1,
        auxShipSyst: -1,
        flags: 0,
        flags2: 0,
        availShipType: -1,
        availBits: '',
        onAccept: 'b150!',
        onRefuse: '',
        onSuccess: 'b151! & S151',
        onFailure: '',
        onAbort: '',
        onShipDone: '',
        require: [],
        datePostInc: 0,
        acceptButton: 'Take Job',
        refuseButton: 'Decline',
        displayWeight: 100,
    };

    it('formats mission prompt fields accurately', () => {
        const prompt: MissionOfferPrompt = {
            mission: mockMission,
            title: mockMission.name,
            text: mockMission.offerText,
            payText: '25,000 cr',
            acceptLabel: mockMission.acceptButton,
            refuseLabel: mockMission.refuseButton,
        };

        expect(prompt.title).toBe('Classified Delivery');
        expect(prompt.text).toContain('sealed data chip');
        expect(prompt.payText).toBe('25,000 cr');
        expect(prompt.acceptLabel).toBe('Take Job');
        expect(prompt.refuseLabel).toBe('Decline');
    });
});

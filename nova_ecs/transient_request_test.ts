import 'jasmine';
import { Component } from './component';
import { Entity } from './entity';
import { consumeRequest } from './transient_request';

describe('consumeRequest', () => {
    const TestRequest = new Component<{ action: string }>('TestRequest');

    it('returns the request data and immediately removes it from the entity', () => {
        const entity = new Entity('player')
            .addComponent(TestRequest, { action: 'board' });

        const consumed = consumeRequest(entity, TestRequest);
        expect(consumed).toEqual({ action: 'board' });
        expect(entity.components.has(TestRequest)).toBeFalse();
    });

    it('returns undefined if the request is not present', () => {
        const entity = new Entity('player');
        const consumed = consumeRequest(entity, TestRequest);
        expect(consumed).toBeUndefined();
    });
});

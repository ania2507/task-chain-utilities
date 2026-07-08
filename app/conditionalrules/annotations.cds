using Services as service from '../../srv/services';

annotate service.RuleTable with {
    Rule @UI.MultiLineText : true
         @HTML5.CssDefaults  : { width: '100%' };
};

annotate service.RuleTable with @(
    UI.HeaderInfo : {
        TypeName : 'Rule',
        TypeNamePlural : 'Rules',
        Title : {
            $Type : 'UI.DataField',
            Value : RuleNumber,
        },
        Description : {
            $Type : 'UI.DataField',
            Value : RuleDescription,
        },
    },
    UI.PresentationVariant : {
        SortOrder : [{
            Property : RuleNumber,
            Descending : false
        }],
        Visualizations : [
            '@UI.LineItem'
        ]
    },
    UI.FieldGroup #GeneralInfo : {
        $Type : 'UI.FieldGroupType',
        Data : [
            {
                $Type : 'UI.DataField',
                Label : 'Rule Number',
                Value : RuleNumber,
            },
            {
                $Type : 'UI.DataField',
                Label : 'Description',
                Value : RuleDescription,
            },
        ],
    },
    UI.Facets : [
        {
            $Type : 'UI.ReferenceFacet',
            ID : 'GeneralInfoFacet',
            Label : 'General Information',
            Target : '@UI.FieldGroup#GeneralInfo',
        },
        {
            $Type : 'UI.ReferenceFacet',
            ID : 'TaskchainsFacet',
            Label : 'Associated Taskchains',
            Target : 'taskchains/@UI.LineItem#Taskchains',
        }, 
    ],
    UI.LineItem : [
        {
            $Type : 'UI.DataField',
            Label : 'Rule ID',
            Value : RuleNumber,
        },
        {
            $Type : 'UI.DataField',
            Label : 'Description',
            Value : RuleDescription,
        },
    ]
);

// Annotations per RuleTaskchainLink
// NB: la colonna "Business Name" è una custom column nel manifest
// (ext/fragment/TaskchainLink.fragment.xml): naviga via router FE perché un
// DataFieldWithUrl con hash diretto rompe la shell di Work Zone.
annotate service.RuleTaskchainLink with @(
    UI.LineItem #Taskchains : [
        {
            $Type : 'UI.DataField',
            Label : 'Technical Name',
            Value : taskchain,
        },
        {
            $Type : 'UI.DataField',
            Label : 'Space',
            Value : spaceId,
        },
        {
            $Type : 'UI.DataField',
            Label : 'Status',
            Value : existsInDsp,
            Criticality : existsInDspCriticality,
        },
    ]
);

// Value Help per taskchain - mostra le taskchain disponibili in DSP
annotate service.RuleTaskchainLink with {
    taskchain @(
        Common.ValueList : {
            $Type : 'Common.ValueListType',
            CollectionPath : 'Taskchain',
            Parameters : [
                {
                    $Type : 'Common.ValueListParameterInOut',
                    LocalDataProperty : taskchain,
                    ValueListProperty : 'name',
                },
                {
                    $Type : 'Common.ValueListParameterDisplayOnly',
                    ValueListProperty : 'businessName',
                },
                {
                    $Type : 'Common.ValueListParameterDisplayOnly',
                    ValueListProperty : 'spaceId',
                },
            ],
        },
        Common.ValueListWithFixedValues : false
    );
};

// Annotations per l'entità Taskchain (anagrafica da DSP)
annotate service.Taskchain with @(
    UI.HeaderInfo : {
        TypeName : 'Taskchain',
        TypeNamePlural : 'Taskchains',
        Title : { Value : name },
        Description : { Value : businessName },
    },
    UI.SelectionFields : [ name, spaceId, businessName ],
    UI.LineItem : [
        { Value : name, Label : 'Technical Name' },
        { Value : businessName, Label : 'Business Name' },
        { Value : spaceId, Label : 'Space' },
        { Value : owner, Label : 'Owner' },
        { Value : deployedBy, Label : 'Deployed By' },
        { Value : deployedAt, Label : 'Deployed At' },
    ],
    UI.FieldGroup #GeneralInfo : {
        $Type : 'UI.FieldGroupType',
        Data : [
            { Value : name, Label : 'Technical Name' },
            { Value : businessName, Label : 'Business Name' },
            { Value : spaceId, Label : 'Space' },
        ],
    },
    UI.FieldGroup #DeploymentInfo : {
        $Type : 'UI.FieldGroupType',
        Data : [
            { Value : owner, Label : 'Owner' },
            { Value : deployedBy, Label : 'Deployed By' },
            { Value : deployedAt, Label : 'Deployed At' },
            { Value : modificationDate, Label : 'Last Modified' },
        ],
    },
    UI.Facets : [
        {
            $Type : 'UI.ReferenceFacet',
            ID : 'GeneralInfoFacet',
            Label : 'General Information',
            Target : '@UI.FieldGroup#GeneralInfo',
        },
        {
            $Type : 'UI.ReferenceFacet',
            ID : 'DeploymentInfoFacet',
            Label : 'Deployment Details',
            Target : '@UI.FieldGroup#DeploymentInfo',
        },
    ]
);

// Annotations per SkipOverride
annotate service.SkipOverride with @(
    UI.HeaderInfo : {
        TypeName : 'Skip Override',
        TypeNamePlural : 'Skip Overrides',
        Title : { Value : taskchain },
        Description : { Value : stepId },
    },
    UI.LineItem : [
        { Value : spaceId, Label : 'Space' },
        { Value : taskchain, Label : 'Taskchain' },
        { Value : stepId, Label : 'Step ID' },
        { Value : stepToBeChecked, Label : 'Step To Be Checked' },
        { Value : override, Label : 'Override' },
        { Value : lastOverrideAt, Label : 'Last Override At' }
    ],
    UI.FieldGroup #GeneralInfo : {
        $Type : 'UI.FieldGroupType',
        Data : [
            { Value : spaceId, Label : 'Space' },
            { Value : taskchain, Label : 'Taskchain' },
            { Value : stepId, Label : 'Step ID' },
            { Value : stepToBeChecked, Label : 'Step To Be Checked' },
            { Value : override, Label : 'Override' },
            { Value : lastOverrideAt, Label : 'Last Override At' }
        ],
    },
    UI.Facets : [
        {
            $Type : 'UI.ReferenceFacet',
            ID : 'GeneralInfoFacet',
            Label : 'General Information',
            Target : '@UI.FieldGroup#GeneralInfo',
        }
    ]
);

